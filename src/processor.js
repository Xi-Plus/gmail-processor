/**
 * Gmail 帳單自動解密存檔 + 清理
 *
 * 需求：
 *   1. 加入 Gmail Processor 函式庫
 *      Script ID: 1Qvk0v7ggfW-TJ84dlYPlDzJG8y-Dif-j9kdA1aWv4wzxE_IOkeV2juLB
 *      識別碼 (identifier) 設為 GmailProcessorLib，版本選最新的數字版本
 *   2. 在「專案設定 > 指令碼屬性」新增每家銀行的密碼，屬性名稱對應下方 BANKS 的 passwordProperty
 *
 * 流程：
 *   runBillProcessor()
 *     1. 函式庫：找還沒有 PROCESSED_LABEL 標籤的帳單 → 加密原檔存到 <銀行>/_原始檔/ → 加上標籤
 *     2. 本專案：把 _原始檔/ 裡沒有解密版本、或原檔較新的 PDF 解密，存到 <銀行>/（取代舊檔；
 *        失敗的下次執行會再試）；成功後依 TRASH_ORIGINAL_AFTER_DECRYPT 把原檔移到垃圾桶
 *   已貼標籤的郵件不會再處理；要重新處理就在 Gmail 移除標籤（存檔、解密都會重做）
 *   cleanupProcessedThreads() 確認 Drive 裡真的有解密檔後，才把郵件移到垃圾桶（30 天內可救回）
 *
 * 解密不用函式庫的 attachment.storeDecryptedPdf：它內部的 pdf-lib 需要 setTimeout，
 * 但 Apps Script 沒有，而函式庫的全域範圍無法從外部補上。因此改用打包進本專案的
 * pdf-lib（src/pdf-lib.js，由 npm run build:pdf-lib 產生）自行解密。
 */

// Apps Script 沒有 setTimeout，pdf-lib 存檔時會用到；改成立即同步執行
if (typeof globalThis.setTimeout === "undefined") {
  globalThis.setTimeout = function (callback, ms) {
    if (ms > 0) Utilities.sleep(ms);
    callback();
    return 0;
  };
}

// ===================== 設定區 =====================

/** "dry-run" = 只記錄不動作；測試沒問題後改成 "safe-mode" */
const RUN_MODE = "safe-mode";

/** 清理函式是否只模擬（true = 只寫 log，不刪信） */
const CLEANUP_DRY_RUN = true;

/** Drive 根資料夾 */
const ROOT_FOLDER = "/archive/帳單";

/** 處理完成後加在郵件上的 Gmail 標籤；有此標籤的郵件不會再被處理 */
const PROCESSED_LABEL = "bills-archived";

/**
 * 解密成功後是否把 _原始檔/ 裡的加密原檔移到垃圾桶（30 天內可救回）。
 * true 之後就無法從原檔重新解密；已有解密檔的舊原檔也會在下次執行時一併移除。
 */
const TRASH_ORIGINAL_AFTER_DECRYPT = true;

/** 每次執行時，每家帳單最多處理幾封（thread）／解密幾個檔案 */
const MAX_BATCH_SIZE = 10;

/** 郵件處理後幾天才移到垃圾桶（給自己發現問題的緩衝時間） */
const CLEANUP_AFTER_DAYS = 7;

/**
 * 每家帳單一筆設定
 *   name:             Drive 子資料夾名稱
 *   query:            Gmail 搜尋條件（建議用 from: 寄件者）
 *   subject:          （選填）標題的正規表示式，同一寄件者有多種帳單時用來區分。
 *                     若含具名群組 (?<year>...) 與 (?<month>...)，檔名年月取自標題，否則取郵件寄送日期；
 *                     民國年改用 (?<rocYear>...)，會自動轉成西元年
 *   attachment:       （選填）附件檔名的正規表示式，只處理符合的 PDF；預設為所有 PDF
 *   passwordProperty: 指令碼屬性中存密碼的名稱
 */
const BANKS = [
  {
    name: "台灣大哥大",
    query: "from:(ebill@ebsmtp01.taiwanmobile.com)",
    subject: "台灣大哥大(?<rocYear>\\d{2,3})年(?<month>\\d{1,2})月份e帳單",
    attachment: "^我的帳單.+\\.pdf$",
    passwordProperty: "PWD_NATIONAL_ID",
  },
  // {
  //   name: "永豐信用卡",
  //   query: "from:(ebillservice@newebill.banksinopac.com.tw) subject:信用卡",
  //   subject: "信用卡(?<year>\\d{4})年(?<month>\\d{1,2})月份電子帳單",
  //   attachment: "帳單\\.pdf$", // 排除「繳款聯.pdf」
  //   passwordProperty: "PWD_NATIONAL_ID",
  // },
  // {
  //   name: "永豐銀行對帳單",
  //   query: "from:(ebillservice@newebill.banksinopac.com.tw)",
  //   subject: "(?<year>\\d{4})年(?<month>\\d{1,2})月份電子綜合對帳單",
  //   passwordProperty: "PWD_NATIONAL_ID",
  // },
  {
    name: "台新信用卡",
    query: "from:(webmaster@bhurecv.taishinbank.com.tw) subject:台新信用卡電子帳單",
    subject: "台新信用卡電子帳單\\s*(?<year>\\d{4})年(?<month>\\d{1,2})月",
    attachment: "^TSB_Creditcard_Estatement_\\d{6}\\.pdf$",
    passwordProperty: "PWD_TAISHIN",
  },
  // 依需要新增...
];

// ===================== 主程式 =====================

async function runBillProcessor() {
  const config = buildConfig_();
  const result = GmailProcessorLib.run(config, RUN_MODE, [], undefined, {
    cacheService: CacheService,
    propertiesService: PropertiesService,
  });
  console.log(JSON.stringify(result, null, 2));

  await decryptPendingFiles_();
  return result;
}

function buildConfig_() {
  // 每家銀行一個資料夾：<ROOT>/<銀行>/ 放解密檔，<ROOT>/<銀行>/_原始檔/ 放原檔
  const threads = BANKS.map((bank) => {
    const bankFolder = `${ROOT_FOLDER}/${bank.name}`;

    // 檔名：<年-月>_<附件名稱>_<message.id>.pdf；清理時用 message.id 確認檔案已存在
    // 月份經 parseDate/formatDate 補零（8 → 08）。
    // 民國年：佔位符不能做加法，改用日期位移 +1911y（1y = 365.25 天，結果落在該年 1 月中，年份正確）
    const hasYear = /\(\?<year>/.test(bank.subject);
    const hasRocYear = /\(\?<rocYear>/.test(bank.subject);
    const hasMonth = /\(\?<month>/.test(bank.subject);
    if (hasYear && hasRocYear) {
      throw new Error(`${bank.name}：subject 不能同時包含 (?<year>...) 與 (?<rocYear>...)`);
    }
    if ((hasYear || hasRocYear) !== hasMonth) {
      throw new Error(`${bank.name}：subject 需同時包含年 (?<year>/(?<rocYear>) 與 (?<month>...)`);
    }
    const match_ = "thread.firstMessageSubject.match";
    const year = hasRocYear
      ? `{{${match_}.rocYear|parseDate('y')|offsetDate('1911y')|formatDate('yyyy')}}`
      : `{{${match_}.year}}`;
    const yearMonth = hasMonth
      ? `${year}-{{${match_}.month|parseDate('M')|formatDate('MM')}}`
      : "{{message.date|formatDate('yyyy-MM')}}";
    const fileName = `${yearMonth}_{{attachment.name.match.base}}_{{message.id}}.pdf`;

    // 函式庫只存加密原檔，解密由 decryptPendingFiles_() 處理
    const actions = [
      {
        name: "attachment.store",
        args: {
          location: `${bankFolder}/${ORIGINALS_SUBFOLDER}/${ORIGINAL_PREFIX}${fileName}`,
          conflictStrategy: "replace",
        },
      },
    ];

    const match = { query: bank.query };
    if (bank.subject) match.firstMessageSubject = bank.subject;

    return {
      description: bank.name,
      match: match,
      attachments: [
        {
          // 不含副檔名的附件名稱存到 match 群組 base
          match: {
            name: `(?i)^(?=(?<base>.*)\\.pdf$).*?${attachmentPattern_(bank)}`,
          },
          actions: actions,
        },
      ],
    };
  });

  return {
    description: "帳單 PDF 存檔",
    settings: {
      // 用標籤記錄已處理，不受已讀/未讀影響（舊信、手動看過的信都會被處理）
      markProcessedMethod: "add-label",
      markProcessedLabel: PROCESSED_LABEL,
      maxBatchSize: MAX_BATCH_SIZE,
    },
    global: {
      thread: {
        // add-label 模式下函式庫會自動加上 -label:<PROCESSED_LABEL>
        match: {
          query: "has:attachment filename:pdf -in:trash -in:drafts -in:spam",
        },
      },
    },
    threads: threads,
  };
}

/** 要處理的附件檔名規則；未指定時處理所有 PDF（開頭的 (?i) 等旗標會移除，因為一律不分大小寫） */
function attachmentPattern_(bank) {
  return (bank.attachment || "\\.pdf$").replace(INLINE_FLAGS_, "");
}

/** 函式庫支援開頭的 (?i) 寫法，但 JavaScript RegExp 不支援，需拆成 flags */
const INLINE_FLAGS_ = /^\(\?([gimsuy]+)\)/;
function toRegExp_(pattern, flags = "") {
  const m = INLINE_FLAGS_.exec(pattern);
  return m
    ? new RegExp(pattern.slice(m[0].length), flags + m[1])
    : new RegExp(pattern, flags);
}

// ===================== 解密 =====================

const ORIGINALS_SUBFOLDER = "_原始檔";
const ORIGINAL_PREFIX = "ORIG_";

/**
 * 把每家銀行 _原始檔/ 裡的 PDF 解密後存到銀行資料夾，解密檔名 = 原檔名去掉 ORIG_ 前綴。
 * 沒有解密檔、或原檔比解密檔新（郵件被重新處理、原檔被覆蓋）時才解密，並取代舊的解密檔。
 * 單一檔案失敗只記錄錯誤，下次執行會再試。
 */
async function decryptPendingFiles_() {
  const props = PropertiesService.getScriptProperties();

  for (const bank of BANKS) {
    const bankFolder = getFolderByPath_(`${ROOT_FOLDER}/${bank.name}`);
    const originalsFolder =
      bankFolder && getFolderByPath_(ORIGINALS_SUBFOLDER, bankFolder);
    if (!originalsFolder) continue;

    const password = props.getProperty(bank.passwordProperty);
    if (password === null) {
      console.warn(`[略過解密] ${bank.name}：指令碼屬性 ${bank.passwordProperty} 未設定`);
      continue;
    }

    let done = 0;
    const originals = originalsFolder.getFiles();
    while (originals.hasNext() && done < MAX_BATCH_SIZE) {
      const original = originals.next();
      const name = original.getName();
      if (!name.startsWith(ORIGINAL_PREFIX)) continue;

      const targetName = name.slice(ORIGINAL_PREFIX.length);
      const existing = [];
      const it = bankFolder.getFilesByName(targetName);
      while (it.hasNext()) existing.push(it.next());
      const upToDate = existing.some(
        (f) => f.getLastUpdated() >= original.getLastUpdated()
      );
      if (upToDate) {
        // 解密檔已是最新（例如開啟 TRASH_ORIGINAL_AFTER_DECRYPT 前留下的原檔）
        trashOriginal_(original, bank);
        continue;
      }

      done++;
      if (RUN_MODE === "dry-run") {
        console.log(`[模擬解密] ${bank.name}/${targetName}`);
        continue;
      }
      try {
        const bytes = await decryptPdf_(original.getBlob().getBytes(), password);
        existing.forEach((f) => f.setTrashed(true)); // 重新處理時取代舊的解密檔
        bankFolder.createFile(Utilities.newBlob(bytes, "application/pdf", targetName));
        console.log(`[已解密] ${bank.name}/${targetName}`);
        trashOriginal_(original, bank);
      } catch (e) {
        console.error(`[解密失敗] ${bank.name}/${name}：${e}`);
      }
    }
  }
}

/** 依 TRASH_ORIGINAL_AFTER_DECRYPT 把已解密的原檔移到垃圾桶 */
function trashOriginal_(original, bank) {
  if (!TRASH_ORIGINAL_AFTER_DECRYPT) return;
  if (RUN_MODE === "dry-run") {
    console.log(`[模擬移除原檔] ${bank.name}/${original.getName()}`);
    return;
  }
  original.setTrashed(true);
  console.log(`[原檔已移到垃圾桶] ${bank.name}/${original.getName()}`);
}

/** 用 pdf-lib 解密 PDF；輸入、輸出都是 Apps Script 的 byte 陣列（-128～127） */
async function decryptPdf_(bytes, password) {
  // 只傳 password 才會解密；加上 ignoreEncryption 會原封不動保留加密
  const pdfDoc = await PDFLib.PDFDocument.load(Uint8Array.from(bytes), {
    password: password,
  });
  removeEncryptionLeftovers_(pdfDoc);
  const decrypted = await pdfDoc.save();
  return Array.from(decrypted, (b) => (b > 127 ? b - 256 : b));
}

/**
 * pdf-lib 解密後內容已是明文，但原檔的加密字典與 XRef stream（內含 /Encrypt 參照）
 * 仍會被原樣寫回，讓輸出檔看起來還是加密的。存檔前把這兩種殘留物件刪掉。
 */
function removeEncryptionLeftovers_(pdfDoc) {
  const { PDFDict, PDFName, PDFInvalidObject } = PDFLib;
  const context = pdfDoc.context;
  const stale = [];
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    const isEncryptDict =
      obj instanceof PDFDict &&
      obj.has(PDFName.of("Filter")) &&
      obj.has(PDFName.of("O")) &&
      obj.has(PDFName.of("U"));
    const isOldXRefStream =
      obj instanceof PDFInvalidObject &&
      /\/Type\s*\/XRef/.test(String.fromCharCode(...obj.data.subarray(0, 512)));
    if (isEncryptDict || isOldXRefStream) stale.push(ref);
  }
  stale.forEach((ref) => context.delete(ref));
}

/** 依路徑（例如 "/archive/帳單"）找資料夾，找不到回傳 null */
function getFolderByPath_(path, parent = DriveApp.getRootFolder()) {
  let folder = parent;
  for (const name of path.split("/").filter(Boolean)) {
    const it = folder.getFoldersByName(name);
    if (!it.hasNext()) return null;
    folder = it.next();
  }
  return folder;
}

// ===================== 清理 =====================

/**
 * 只有當郵件中每個 PDF 附件都在 Drive 找到對應的解密檔時，才把整串郵件移到垃圾桶。
 * 沒處理成功的信（例如密碼錯誤）會被保留下來。
 */
function cleanupProcessedThreads() {
  BANKS.forEach((bank) => {
    const query =
      `${bank.query} has:attachment filename:pdf -in:trash label:${PROCESSED_LABEL} ` +
      `older_than:${CLEANUP_AFTER_DAYS}d`;
    const subjectRegex = bank.subject ? toRegExp_(bank.subject) : null;
    const threads = GmailApp.search(query, 0, 50).filter(
      (t) => !subjectRegex || subjectRegex.test(t.getFirstMessageSubject())
    );

    threads.forEach((thread) => {
      const subject = thread.getFirstMessageSubject();
      if (!hasAllDecryptedFiles_(thread, bank)) {
        console.warn(`[保留] ${bank.name}：${subject}（Drive 中找不到完整的解密檔）`);
        return;
      }

      if (CLEANUP_DRY_RUN) {
        console.log(`[模擬刪除] ${bank.name}：${subject}`);
      } else {
        thread.moveToTrash();
        console.log(`[已移到垃圾桶] ${bank.name}：${subject}`);
      }
    });
  });
}

/** thread 中每個符合 attachment 規則的附件，Drive 裡是否都有對應的解密檔 */
function hasAllDecryptedFiles_(thread, bank) {
  const attachmentRegex = toRegExp_(attachmentPattern_(bank), "i");
  let pdfCount = 0;
  const allSaved = thread.getMessages().every((msg) => {
    const n = msg.getAttachments().filter((a) => attachmentRegex.test(a.getName())).length;
    pdfCount += n;
    return n === 0 || countDecryptedFiles_(msg.getId()) >= n;
  });
  return pdfCount > 0 && allSaved;
}

/** 計算 Drive 中檔名含此 message id、且不是原始檔備份的檔案數 */
function countDecryptedFiles_(messageId) {
  const files = DriveApp.searchFiles(
    `title contains '${messageId}' and trashed = false`
  );
  let count = 0;
  while (files.hasNext()) {
    if (!files.next().getName().startsWith(ORIGINAL_PREFIX)) count++;
  }
  return count;
}

// ===================== 排程設定（執行一次即可） =====================

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger("runBillProcessor").timeBased().everyHours(6).create();
  ScriptApp.newTrigger("cleanupProcessedThreads")
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();

  console.log("觸發器已建立：每 6 小時處理帳單、每天凌晨 3 點清理");
}
