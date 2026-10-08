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
node --check src/config.js      # 本機語法檢查（一次只能檢查一個檔案）
node --check src/processor.js
```

沒有測試框架。程式只能在 Apps Script 上實際執行（`runBillProcessor`、`cleanupProcessedThreads`、`setupTriggers`）。本機驗證的做法是用 Node 的 `vm` 在同一個 context 依序載入 `src/config.js`、`src/processor.js`，以假的 `GmailApp`/`DriveApp`/`Utilities`/`PropertiesService` 物件測試純邏輯，或在沒有 `setTimeout` 的 `vm` context 中載入 `src/pdf-lib.js` 模擬 Apps Script 測解密。

## 架構

邏輯在 `src/processor.js`，設定在 `src/config.js`（Apps Script 所有檔案共用全域範圍，設定只在函式內被讀取，載入順序不影響）。不使用外部 Apps Script 函式庫（曾用 Gmail Processor 函式庫，因流程與陷阱過多而移除）。`src/config.js` 的常數（`DRY_RUN`、`CLEANUP_DRY_RUN`、`PROCESSED_LABEL`、`MAX_BATCH_SIZE`、`CLEANUP_AFTER_DAYS`）和 `BANKS` 陣列是使用者主要修改的地方。README 分英文（`README.md`）與繁體中文（`README.zh-TW.md`），修改設定欄位時兩份都要同步。

### 處理流程（`runBillProcessor`）

每家銀行用 `bank.query` 加上 `-label:<PROCESSED_LABEL>` 搜尋（最多 `MAX_BATCH_SIZE` 封，再用 `subject` 過濾標題），逐封 thread：
1. `billFiles_` 列出要存的 PDF 附件與目標檔名；`bank.folder`（每筆設定獨立的完整 Drive 路徑）裡已有這封郵件存的同名檔案就略過，同名檔案屬於其他郵件則記錄「檔名衝突」並不貼標籤，否則直接從郵件附件解密（沒設 `passwordProperty` 則不解密）後存檔。資料夾不存在時才建立。
2. 每個附件都有檔案才貼 `PROCESSED_LABEL` 並標為已讀；沒有符合附件的郵件也會貼，避免每次被重新處理。失敗的郵件不貼標籤，下次執行從郵件附件重試。

超過 `MAX_RUNTIME_MS_`（5 分鐘）就不再開始處理新郵件，避開 Apps Script 6 分鐘的執行上限。

### pdf-lib 解密的陷阱（`decryptPdf_` / `removeEncryptionLeftovers_`）

- Apps Script 沒有 `setTimeout`，pdf-lib 存檔時會呼叫，所以檔案頂層自訂同步版。pdf-lib 由 `npm run build:pdf-lib` 打包成全域變數 `PDFLib`（`scripts/pdf-lib-entry.js` 決定匯出哪些類別）。
- `BANKS[].passwordProperty` 是 `null | string | (year, month) => string | null`（`passwordPropertyFor_`）。函式用於銀行換過密碼的情況，傳入的年月與檔名相同（`billYearMonth_`）。結果為 null 表示 PDF 未加密，附件原封不動存檔。
- `PDFDocument.load` 只能傳 `password`；加上 `ignoreEncryption: true` 會跳過解密。
- 解密後原檔的加密字典與舊 XRef stream（被當成 `PDFInvalidObject`，內含 `/Encrypt` 參照）會被原樣寫回，導致輸出看起來仍是加密的；存檔前必須刪除這些物件。
- Apps Script 的 byte 陣列是 -128～127，進出 pdf-lib 要和 `Uint8Array` 互轉。

### 檔名

`billYearMonth_` 算出帳單年月，`billFiles_` 決定檔名：
- 帳單年月的採用順序：`BANKS[].subject`（thread 第一封郵件標題，同時也是過濾條件）→ `BANKS[].body`（該封郵件 `getPlainBody()`，只用來取年月）→ 該封郵件寄送時間（固定 `GMT+8`）。前兩者用具名群組 `(?<year>)` 或 `(?<rocYear>)`（民國年，+1911）加 `(?<month>)`，`validateBank_` 檢查群組組合；沒比對到或群組為空就換下一個來源（`yearMonthFromText_`）。
- `BANKS[].attachment` 未設定時存所有 PDF，檔名為 `<yyyy-MM>_<附件名去副檔名>_<message.id>.pdf`；設定為函式 `(a) => 檔名 | null` 時每個 PDF 附件呼叫一次（`a` 含 `name`、`base`、`yyyy`、`m`、`mm`（補零的月份，皆為字串）、`messageId`、`subject`、`defaultName`），回傳 null 表示略過，沒有 `.pdf` 會補上。只會傳入 `.pdf` 結尾的附件。
- 「是否已存檔」用完整檔名在銀行資料夾比對（`savedFileStatus_`，排除垃圾桶）。存檔時把 `gmail-message-id:<id>` 寫進 Drive 檔案說明，用來分辨同名檔案是否來自同一封郵件（避免自訂檔名撞名時誤判已存檔、進而被清理刪信）；說明欄沒有來源 ID 的舊檔視為已存檔。處理、清理（`hasAllFiles_`）都靠同一個 `billFiles_`，修改檔名規則會讓舊檔被視為不存在而重存。

### 已處理的判斷

- 只看 Gmail 標籤：有 `PROCESSED_LABEL` 的 thread 不再處理。
- 要重新處理：移除標籤並刪除 Drive 中的檔案（只移除標籤的話，檔案仍在，會直接重新貼上標籤）。
- `cleanupProcessedThreads` 只在 thread 至少有一個符合規則的附件、且每個都找得到檔案時才移到垃圾桶。
- Drive 的 `getFilesByName` 也會找到垃圾桶中的檔案，要用 `isTrashed()` 排除。

## pdf-lib 版本

`@cantoo/pdf-lib` 固定為 2.9.1（解密與 `removeEncryptionLeftovers_` 依賴其內部行為，例如錯誤訊息 `Password incorrect`、`PDFInvalidObject`），升級時要重新驗證解密。
