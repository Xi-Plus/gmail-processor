# Gmail Bill Archiver

English | [繁體中文](README.zh-TW.md)

A Google Apps Script project that finds bill emails in Gmail, decrypts their (usually password-protected) PDF attachments, saves them to Google Drive, and cleans up the emails once the files are confirmed saved.

- Per-bill settings for search query, Drive folder, file name, and password
- Bill year/month taken from the email subject, body, or send date (Taiwan ROC years supported)
- Choose a different password by bill year/month when a bank changes it
- An email is marked processed only after all its attachments are saved; failures are retried on the next run
- Cleanup checks Drive for the saved files again before deleting any email

## How it works

For each bill configuration, `runBillProcessor()`:

1. Searches with `query` for emails without the `bills-archived` label (up to `MAX_BATCH_SIZE` per run), then filters by `subject`
2. For each PDF attachment, if Drive doesn't already have the file, decrypts it with the password from Script Properties and saves it to `folder`
3. Adds the `bills-archived` label and marks the email as read only after every attachment in the email has a file; otherwise leaves it for the next run

`cleanupProcessedThreads()` finds labeled emails older than `CLEANUP_AFTER_DAYS` days and moves them to the trash (recoverable for 30 days) only if every attachment is found in Drive.

## Setup

Requires Node.js and a Google account.

1. Install dependencies and log in to clasp:

   ```bash
   npm install
   npm run login
   ```

   The first time you use clasp, enable "Google Apps Script API" at <https://script.google.com/home/usersettings>.

2. Create an Apps Script project (or reuse an existing one):

   ```bash
   npm run create
   ```

   To reuse an existing project, copy `.clasp.json.example` to `.clasp.json` and fill in the Script ID (found in the project settings).

3. Bundle pdf-lib and push the code:

   ```bash
   npm run build:pdf-lib   # generates src/pdf-lib.js (not versioned; must exist before every push)
   npm run push
   ```

4. In the Apps Script editor, add passwords under **Project Settings > Script Properties**. Property names must match `passwordProperty` in the config, for example:

   | Property | Value |
   |---|---|
   | `PWD_NATIONAL_ID` | National ID number |
   | `PWD_TAISHIN` | Taishin credit card statement password |

   Passwords live only in Script Properties, never in the code.

## Configuration

All settings are in [src/config.js](src/config.js); the logic is in [src/processor.js](src/processor.js).

| Constant | Description |
|---|---|
| `DRY_RUN` | When `true`, only logs; no files saved, no labels added |
| `CLEANUP_DRY_RUN` | When `true`, cleanup only logs; no emails deleted |
| `PROCESSED_LABEL` | Gmail label for processed emails (default `bills-archived`) |
| `MAX_BATCH_SIZE` | Maximum emails per bill configuration per run |
| `CLEANUP_AFTER_DAYS` | Days after processing before an email is cleaned up |

### Bill configurations: `BANKS`

One object per bill type:

| Field | Required | Description |
|---|---|---|
| `name` | ✓ | Display name used in logs |
| `folder` | ✓ | Drive folder path to save into; created if missing |
| `query` | ✓ | Gmail search query; use `from:` plus `subject:` to narrow it down |
| `subject` | | Regex on the subject; filters emails and can provide the bill year/month |
| `body` | | Regex on the plain-text body; only used for the bill year/month |
| `attachment` | | Function deciding which PDF attachments to save and their file names |
| `passwordProperty` | | Script Property name holding the password, or a function of year/month; omit for unencrypted PDFs |

Example:

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
  // New password from the December 2024 statement onward
  passwordProperty: (year, month) =>
    year * 100 + month >= 202412 ? "PWD_TAISHIN" : "PWD_NATIONAL_ID",
},
```

#### Bill year/month

The first source that yields a value wins:

1. Named groups in `subject`
2. Named groups in `body`
3. The email's send date (UTC+8)

Use `(?<year>...)` or `(?<rocYear>...)` (Taiwan ROC year, 1911 is added automatically) together with `(?<month>...)`:

```js
subject: "台灣大哥大(?<rocYear>\\d{2,3})年(?<month>\\d{1,2})月份e帳單",
body: "附件為您(?<year>\\d{4})/(?<month>\\d{1,2})的證券月對帳單",
```

`subject` and `body` are strings, so backslashes must be doubled (`\\d`).

#### File names: `attachment`

If omitted, every PDF attachment is saved as `<yyyy-MM>_<attachment name>_<message ID>.pdf`.

If set to a function, it is called once per PDF attachment. Return a file name to save it, or `null` to skip it (`.pdf` is appended if missing). The argument `a` has:

| Property | Example | Description |
|---|---|---|
| `name` | `"TSB_202504.pdf"` | Attachment file name |
| `base` | `"TSB_202504"` | Attachment file name without `.pdf` |
| `yyyy` | `"2025"` | Bill year |
| `m` | `"4"` | Bill month |
| `mm` | `"04"` | Bill month, zero-padded |
| `messageId` | | Gmail message ID |
| `subject` | | Email subject |
| `defaultName` | | The default file name |

The file name is how "already saved" is detected, so different emails must produce different names (including the year/month is usually enough). If two emails produce the same name, the later one logs `[檔名衝突]` (file name conflict) and is not labeled; the existing file is never overwritten.

#### Passwords: `passwordProperty`

- Omitted or `null`: the PDF isn't encrypted and is saved as is
- String: the Script Property name
- Function `(year, month) => property name | null`: chosen by bill year/month (numbers), for banks that changed passwords

## Running

1. Set `DRY_RUN` to `true`, push, and run `runBillProcessor` in the Apps Script editor. The first run asks for Gmail and Drive authorization
2. Check that the `[模擬存檔]` (simulated save) file names in the execution log look right
3. Set `DRY_RUN` back to `false` and run again; confirm the files are in Drive and the emails are labeled
4. Run `setupTriggers` once to schedule processing every 6 hours and cleanup daily at 3 AM
5. After a few days of correct `[模擬刪除]` (simulated delete) logs, set `CLEANUP_DRY_RUN` to `false`

### Common log messages

Log messages are in Traditional Chinese:

| Log | Meaning |
|---|---|
| `[已存檔] …（用 PWD_X 解密）` | Decrypted and saved |
| `[存檔失敗] …：Error: Password incorrect` | Wrong password; check `passwordProperty` and the Script Property value |
| `[存檔失敗] …：Error: 指令碼屬性 X 未設定` | The Script Property hasn't been added |
| `[檔名衝突] …` | Another email already uses this file name; adjust `attachment` |
| `[未貼標籤] …` | Some attachment wasn't saved; retried on the next run |
| `[時間不足] …` | Near the 6-minute Apps Script limit; remaining emails wait for the next run |

### Reprocessing

Remove the `bills-archived` label from the email in Gmail and delete the corresponding file in Drive; the next run saves it again. If you only remove the label, the file still exists and the label is simply re-added.

## Development

```bash
node --check src/config.js      # syntax check
node --check src/processor.js
npx clasp status                # list files that will be pushed
npm run logs                    # view execution logs
```

There's no test framework; the code only runs on Apps Script. Locally, load `src/pdf-lib.js`, `src/config.js`, and `src/processor.js` in order with Node's `vm` module and test the logic with fake `GmailApp`/`DriveApp` objects. See [CLAUDE.md](CLAUDE.md) for architecture details and pdf-lib decryption caveats.

`@cantoo/pdf-lib` is pinned to 2.9.1; re-verify decryption before upgrading.
