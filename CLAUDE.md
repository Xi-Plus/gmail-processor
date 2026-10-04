# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概要

Google Apps Script 專案（V8 runtime），用 clasp 在本機開發。功能：從 Gmail 找帳單郵件，把加密 PDF 附件解密後存到 Google Drive，並在確認存檔後清理郵件。程式碼註解、log 訊息、使用者溝通都用繁體中文。

## 常用指令

```bash
npm run build:pdf-lib   # 打包 @cantoo/pdf-lib → src/pdf-lib.js（已 gitignore，push 前必須先產生）
npm run push            # clasp push（只推 src/ 底下的 appsscript.json 與 .js/.gs）
npm run pull / open / logs
npx clasp status        # 確認會被推送的檔案
node --check src/processor.js   # 本機語法檢查
```

沒有測試框架。程式只能在 Apps Script 上實際執行（`runBillProcessor`、`cleanupProcessedThreads`、`setupTriggers`）。本機驗證的做法是用 Node 載入 `src/processor.js`，以假的 `GmailApp`/`DriveApp`/`Utilities`/`PropertiesService` 物件測試純邏輯，或在沒有 `setTimeout` 的 `vm` context 中載入 `src/pdf-lib.js` 模擬 Apps Script 測解密。

## 架構

所有邏輯都在 `src/processor.js`。上方「設定區」的常數（`RUN_MODE`、`CLEANUP_DRY_RUN`、`ROOT_FOLDER`、`PROCESSED_LABEL`、`TRASH_ORIGINAL_AFTER_DECRYPT`、`MAX_BATCH_SIZE`、`CLEANUP_AFTER_DAYS`）和 `BANKS` 陣列是使用者主要修改的地方。

### 兩階段處理（`runBillProcessor`）

1. **Gmail Processor 函式庫**（`GmailProcessorLib`，Script ID 與版本在 `src/appsscript.json`）：`buildConfig_()` 把 `BANKS` 轉成函式庫設定，函式庫搜尋郵件、把**加密原檔**存到 `<ROOT>/<銀行>/_原始檔/ORIG_<檔名>`，並在 thread 貼上 `PROCESSED_LABEL` 標籤（`markProcessedMethod: "add-label"`，函式庫會自動在搜尋條件加 `-label:...`）。
2. **本專案自行解密**（`decryptPendingFiles_`）：掃描 `_原始檔/`，沒有解密檔或原檔較新（依 `getLastUpdated()` 比較）時，用打包進專案的 pdf-lib 解密，存成 `<ROOT>/<銀行>/<檔名>`（取代舊檔），成功後依設定把原檔移到垃圾桶。

**為什麼不用函式庫的 `attachment.storeDecryptedPdf`**：函式庫內部的 pdf-lib 存檔時呼叫 `setTimeout`，Apps Script 沒有；函式庫有獨立的全域範圍，無法從本專案補上（`Function.prototype.constructor` 在 Apps Script 被禁止）。所以本專案在頂層自訂同步版 `setTimeout`，並自己打包 pdf-lib（`scripts/pdf-lib-entry.js` 決定匯出哪些類別，`PDFLib` 全域變數）。

### pdf-lib 解密的陷阱（`decryptPdf_` / `removeEncryptionLeftovers_`）

- `PDFDocument.load` 只能傳 `password`；加上 `ignoreEncryption: true` 會跳過解密（函式庫就是這樣寫的）。
- 解密後原檔的加密字典與舊 XRef stream（被當成 `PDFInvalidObject`，內含 `/Encrypt` 參照）會被原樣寫回，導致輸出看起來仍是加密的；存檔前必須刪除這些物件。
- Apps Script 的 byte 陣列是 -128～127，進出 pdf-lib 要和 `Uint8Array` 互轉。

### 檔名與佔位符

檔名格式 `<yyyy-MM>_<附件名去副檔名>_<message.id>.pdf`，由函式庫的 `{{...}}` 佔位符在執行時代換：
- `BANKS[].subject` 是標題正規表示式（對應函式庫的 `firstMessageSubject`），可用具名群組 `(?<year>)` 或 `(?<rocYear>)`（民國年）加 `(?<month>)` 從標題取年月，否則用郵件日期。佔位符不能做加法，民國年用 `parseDate('y')|offsetDate('1911y')` 轉換（1y = 365.25 天，結果落在該年 1 月中）；月份用 `parseDate('M')|formatDate('MM')` 補零。
- 附件比對規則由 `attachmentPattern_(bank)` 加上 lookahead `(?<base>...)` 組成，用來取得去掉 `.pdf` 的檔名。
- 檔名中的 `message.id` 是清理功能的依據：`countDecryptedFiles_` 用它在 Drive 搜尋檔案（排除 `ORIG_` 開頭）。

### 正規表示式需在兩處一致

函式庫支援開頭的 `(?i)`，原生 JS `RegExp` 不支援。本專案直接建 RegExp 的地方（清理、檢查）一律透過 `toRegExp_()`，附件規則透過 `attachmentPattern_()`（移除開頭旗標）。修改 `subject`/`attachment` 的處理時，函式庫設定（`buildConfig_`）與清理（`cleanupProcessedThreads`/`hasAllDecryptedFiles_`）兩邊要同步。

### 已處理的判斷

- 只看 Gmail 標籤：有 `PROCESSED_LABEL` 的 thread 不再處理；要重新處理就移除標籤（存檔、解密都會重做）。
- 函式庫對非同步 action 不會等待，標籤會在非同步失敗前就貼上——這也是解密改在函式庫外處理的原因之一。
- `cleanupProcessedThreads` 只在 thread 每個符合規則的附件都找得到解密檔時才移到垃圾桶。

## 函式庫原始碼

需要確認 Gmail Processor 函式庫行為（佔位符語法、action 實作、`run()` 參數順序 `run(config, runMode, customActions, ctx, envOverrides)`）時，參考 https://github.com/ahochsteger/gmail-processor 的 `src/lib/`；本專案使用的版本是 v2.17.4（Apps Script library version 44），內含 `@cantoo/pdf-lib` 2.9.1，本專案的 pdf-lib 版本固定與其一致。
