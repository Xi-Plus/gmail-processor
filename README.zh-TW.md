# Gmail 帳單自動解密存檔

[English](README.md) | 繁體中文

Google Apps Script 專案：從 Gmail 找出帳單郵件，把（通常有密碼的）PDF 附件解密後存到 Google Drive，並在確認存檔後清理郵件。

- 每家銀行／帳單各自設定搜尋條件、存檔資料夾、檔名與密碼
- 帳單年月可從郵件標題、內文或寄件時間取得，支援民國年
- 銀行換過密碼時，可依帳單年月選用不同密碼
- 只有附件全部存檔成功才標記為已處理；失敗的郵件下次執行會自動重試
- 清理郵件前會再次確認 Drive 裡有對應檔案

## 運作方式

`runBillProcessor()` 對每筆帳單設定：

1. 用 `query` 搜尋還沒有 `bills-archived` 標籤的郵件（每次最多 `MAX_BATCH_SIZE` 封），再用 `subject` 過濾標題
2. 逐封郵件處理每個 PDF 附件：Drive 裡還沒有對應檔案時，用指令碼屬性中的密碼解密，存到 `folder`
3. 該封郵件所有附件都有檔案後，才貼上 `bills-archived` 標籤並標為已讀；有任何失敗就不貼，下次再試

`cleanupProcessedThreads()` 找出已貼標籤且超過 `CLEANUP_AFTER_DAYS` 天的郵件，確認每個附件都在 Drive 找得到檔案後，才移到垃圾桶（30 天內可從 Gmail 垃圾桶救回）。

## 安裝

需要 Node.js 與一個 Google 帳號。

1. 安裝相依套件並登入 clasp：

   ```bash
   npm install
   npm run login
   ```

   第一次使用 clasp 需要先在 <https://script.google.com/home/usersettings> 開啟「Google Apps Script API」。

2. 建立 Apps Script 專案（或沿用既有專案）：

   ```bash
   npm run create
   ```

   沿用既有專案時，把 `.clasp.json.example` 複製成 `.clasp.json`，填入 Script ID（專案設定頁可找到）。

3. 打包 pdf-lib 並推送程式碼：

   ```bash
   npm run build:pdf-lib   # 產生 src/pdf-lib.js（不納入版本控制，每次 push 前都要存在）
   npm run push
   ```

4. 在 Apps Script 編輯器的「專案設定 > 指令碼屬性」新增密碼，屬性名稱需與設定中的 `passwordProperty` 一致，例如：

   | 屬性 | 值 |
   |---|---|
   | `PWD_NATIONAL_ID` | 身分證字號 |
   | `PWD_TAISHIN` | 台新信用卡帳單密碼 |

   密碼只存在指令碼屬性中，不會出現在程式碼裡。

## 設定

所有設定都在 [src/config.js](src/config.js)，程式邏輯在 [src/processor.js](src/processor.js)。

| 常數 | 說明 |
|---|---|
| `DRY_RUN` | `true` 時只寫 log，不存檔也不貼標籤 |
| `CLEANUP_DRY_RUN` | `true` 時清理只寫 log，不刪信 |
| `PROCESSED_LABEL` | 已處理郵件的 Gmail 標籤（預設 `bills-archived`） |
| `MAX_BATCH_SIZE` | 每次執行每筆帳單最多處理幾封郵件 |
| `CLEANUP_AFTER_DAYS` | 郵件處理後幾天才清理 |

### 帳單設定 `BANKS`

每筆帳單一個物件：

| 欄位 | 必填 | 說明 |
|---|---|---|
| `name` | ✓ | 名稱，用於 log |
| `folder` | ✓ | 存檔的 Drive 資料夾路徑，不存在時自動建立 |
| `query` | ✓ | Gmail 搜尋條件，建議用 `from:` 加上 `subject:` 縮小範圍 |
| `subject` | | 標題的正規表示式，用來過濾郵件，也可以取帳單年月 |
| `body` | | 內文（純文字）的正規表示式，只用來取帳單年月 |
| `attachment` | | 函式，決定存哪些 PDF 附件、存成什麼檔名 |
| `passwordProperty` | | 密碼的指令碼屬性名稱，或依年月決定的函式；不填表示 PDF 沒有加密 |

範例：

```js
{
  name: "台新信用卡",
  folder: "/archive/帳單/台新信用卡",
  query: "from:(webmaster@bhurecv.taishinbank.com.tw) subject:台新信用卡電子帳單",
  subject: "台新信用卡電子帳單\\s*(?<year>\\d{4})年(?<month>\\d{1,2})月",
  attachment: (a) =>
    /^TSB_Creditcard_Estatement_\d{6}\.pdf$/i.test(a.name)
      ? `${a.yyyy}-${a.mm}_台新信用卡帳單.pdf`
      : null,
  // 2024 年 12 月帳單起改用新密碼
  passwordProperty: (year, month) =>
    year * 100 + month >= 202412 ? "PWD_TAISHIN" : "PWD_NATIONAL_ID",
},
```

#### 帳單年月

依序採用第一個取得到的來源：

1. `subject` 的具名群組
2. `body` 的具名群組
3. 郵件寄件時間（UTC+8）

具名群組用 `(?<year>...)` 或 `(?<rocYear>...)`（民國年，自動加 1911），並搭配 `(?<month>...)`，例如：

```js
subject: "台灣大哥大(?<rocYear>\\d{2,3})年(?<month>\\d{1,2})月份e帳單",
body: "附件為您(?<year>\\d{4})/(?<month>\\d{1,2})的證券月對帳單",
```

`subject` 與 `body` 是字串，反斜線要寫兩次（`\\d`）。

#### 檔名 `attachment`

不設定時存所有 PDF 附件，檔名為 `<yyyy-MM>_<附件名>_<郵件ID>.pdf`。

設定為函式時，每個 PDF 附件呼叫一次，回傳檔名表示存檔，回傳 `null` 表示略過（檔名沒有 `.pdf` 會自動補上）。函式參數 `a`：

| 屬性 | 範例 | 說明 |
|---|---|---|
| `name` | `"TSB_202504.pdf"` | 附件檔名 |
| `base` | `"TSB_202504"` | 去掉 `.pdf` 的附件檔名 |
| `yyyy` | `"2025"` | 帳單年 |
| `m` | `"4"` | 帳單月 |
| `mm` | `"04"` | 帳單月（補零） |
| `messageId` | | 郵件 ID |
| `subject` | | 郵件標題 |
| `defaultName` | | 預設檔名 |

檔名是判斷「是否已存檔」的依據，不同郵件必須得到不同的檔名（通常含年月即可）。如果兩封郵件算出相同檔名，後者會記錄 `[檔名衝突]` 且不貼標籤，不會覆蓋既有檔案。

#### 密碼 `passwordProperty`

- 不填或 `null`：PDF 沒有加密，直接存檔
- 字串：指令碼屬性名稱
- 函式 `(year, month) => 屬性名稱 | null`：依帳單年月（數字）決定，適用於銀行換過密碼的情況

## 執行

1. 先把 `DRY_RUN` 設為 `true`，push 後在 Apps Script 編輯器執行 `runBillProcessor`，第一次會要求授權 Gmail 與 Drive
2. 檢查執行記錄中的 `[模擬存檔]` 檔名是否正確
3. 確認無誤後把 `DRY_RUN` 改回 `false` 再執行一次，確認 Drive 有檔案、郵件有貼標籤
4. 執行一次 `setupTriggers` 建立排程：每 6 小時處理帳單、每天凌晨 3 點清理
5. 觀察幾天清理的 `[模擬刪除]` 記錄沒問題後，把 `CLEANUP_DRY_RUN` 改為 `false`

### 常見記錄

| 記錄 | 意思 |
|---|---|
| `[已存檔] …（用 PWD_X 解密）` | 解密並存檔成功 |
| `[存檔失敗] …：Error: Password incorrect` | 密碼錯誤，檢查 `passwordProperty` 與指令碼屬性的值 |
| `[存檔失敗] …：Error: 指令碼屬性 X 未設定` | 指令碼屬性還沒新增 |
| `[檔名衝突] …` | 另一封郵件已用了這個檔名，調整 `attachment` |
| `[未貼標籤] …` | 這封郵件有附件沒存成功，下次執行會再試 |
| `[時間不足] …` | 接近 Apps Script 6 分鐘上限，剩下的郵件留到下次 |

### 重新處理

在 Gmail 移除該郵件的 `bills-archived` 標籤，並刪除 Drive 中對應的檔案，下次執行就會重新存檔。只移除標籤的話，檔案仍在，會直接重新貼上標籤。

## 開發

```bash
node --check src/config.js      # 語法檢查
node --check src/processor.js
npx clasp status                # 確認會被推送的檔案
npm run logs                    # 查看執行記錄
```

沒有測試框架，程式只能在 Apps Script 上實際執行。本機可用 Node 的 `vm` 模組依序載入 `src/pdf-lib.js`、`src/config.js` 與 `src/processor.js`，搭配假的 `GmailApp`／`DriveApp` 物件測試邏輯。架構細節與 pdf-lib 解密的注意事項見 [CLAUDE.md](CLAUDE.md)。

`@cantoo/pdf-lib` 固定為 2.9.1，升級前需重新驗證解密結果。
