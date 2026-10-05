/**
 * Gmail 帳單自動解密存檔 + 清理
 *
 * 需求：
 *   在「專案設定 > 指令碼屬性」新增每家銀行的密碼，屬性名稱對應下方 BANKS 的 passwordProperty
 *
 * 流程：
 *   runBillProcessor()
 *     每家銀行找還沒有 PROCESSED_LABEL 標籤的帳單郵件（最多 MAX_BATCH_SIZE 封），逐封：
 *       1. 每個符合規則的 PDF 附件：Drive 裡還沒有對應檔案時，解密後存到 bank.folder/<檔名>
 *          （沒設 passwordProperty 的銀行 PDF 未加密，直接存檔）
 *       2. 每個附件都有檔案時，才貼上 PROCESSED_LABEL
 *   已貼標籤的郵件不會再處理；沒貼上標籤的（例如解密失敗）每次執行都會從郵件附件重試
 *   要重新處理：在 Gmail 移除標籤，並刪除 Drive 中的檔案
 *   cleanupProcessedThreads() 確認 Drive 裡真的有檔案後，才把郵件移到垃圾桶（30 天內可救回）
 *
 * 解密使用打包進本專案的 pdf-lib（src/pdf-lib.js，由 npm run build:pdf-lib 產生）。
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

/** true = 只記錄不動作（不存檔、不貼標籤）；測試沒問題後改成 false */
const DRY_RUN = false;

/** 清理函式是否只模擬（true = 只寫 log，不刪信） */
const CLEANUP_DRY_RUN = true;

/** 存檔完成後加在郵件上的 Gmail 標籤；有此標籤的郵件不會再被處理 */
const PROCESSED_LABEL = "bills-archived";

/** 每次執行時，每家帳單最多處理幾封（thread） */
const MAX_BATCH_SIZE = 10;

/** 郵件處理後幾天才移到垃圾桶（給自己發現問題的緩衝時間） */
const CLEANUP_AFTER_DAYS = 7;

/**
 * 每家帳單一筆設定
 *   name:             名稱，用於 log
 *   folder:           存檔的 Drive 資料夾路徑（例如 "/archive/帳單/台新信用卡"），不存在時自動建立；
 *                     不同帳單可以共用同一個資料夾（預設檔名含 message.id，不會衝突）
 *   query:            Gmail 搜尋條件（建議用 from: 寄件者）
 *   subject:          （選填）標題的正規表示式，同一寄件者有多種帳單時用來區分。
 *                     可含具名群組 (?<year>...)（民國年用 (?<rocYear>...)，自動轉西元）與 (?<month>...) 取帳單年月
 *   body:             （選填）郵件內文（純文字）的正規表示式，只用來取年月，具名群組規則同 subject
 *                     帳單年月的採用順序：subject → body → 寄件時間（UTC+8）
 *   attachment:       （選填）決定要存哪些 PDF 附件、存成什麼檔名。不填則存所有 PDF，檔名為
 *                     <yyyy-MM>_<附件名去副檔名>_<message.id>.pdf。
 *                     函式 (a) => 檔名 | null：每個 PDF 附件呼叫一次，回傳 null 表示略過；沒有 .pdf 會自動補上。
 *                     a = { name, base（去副檔名）, yyyy（例如 "2025"）, m（例如 "4"）, mm（補零，例如 "04"）, messageId, subject, defaultName }
 *                     檔名是判斷「已存檔」的依據，必須能區分不同郵件（例如含年月或 messageId），否則後來的會被略過。例：
 *                       attachment: (a) => {
 *                         const m = /^TSB_Creditcard_Estatement_(\d{6})\.pdf$/i.exec(a.name);
 *                         return m && `台新信用卡_${m[1]}.pdf`;
 *                       },
 *   passwordProperty: （選填）指令碼屬性中存密碼的名稱。不填或 null 表示 PDF 沒有加密，附件直接存檔。
 *                     銀行換過密碼時可用函式 (year, month) => 屬性名稱 | null，依帳單年月（與檔名相同）決定
 */
const BANKS = [
  {
    name: "台灣大哥大",
    folder: "/archive/帳單/台灣大哥大",
    query: "from:(ebill@ebsmtp01.taiwanmobile.com) subject:e帳單",
    subject: "台灣大哥大(?<rocYear>\\d{2,3})年(?<month>\\d{1,2})月份e帳單",
    attachment: (a) =>
      /^我的帳單.+\.pdf$/i.test(a.name) ? `${a.yyyy}-${a.mm}_台灣大哥大帳單.pdf` : null,
    passwordProperty: "PWD_NATIONAL_ID",
  },
  {
    name: "永豐信用卡",
    folder: "/archive/帳單/永豐信用卡",
    query: "from:(ebillservice@newebill.banksinopac.com.tw) subject:信用卡",
    subject: "信用卡(?<year>\\d{4})年(?<month>\\d{1,2})月份電子帳單",
    // 排除「繳款聯.pdf」
    attachment: (a) => (/帳單\.pdf$/i.test(a.name) ? `${a.yyyy}-${a.mm}_永豐信用卡帳單.pdf` : null),
    passwordProperty: "PWD_NATIONAL_ID",
  },
  {
    name: "永豐銀行對帳單",
    folder: "/archive/帳單/永豐銀行對帳單",
    query: "from:(ebillservice@newebill.banksinopac.com.tw) subject:電子綜合對帳單",
    subject: "(?<year>\\d{4})年(?<month>\\d{1,2})月份電子綜合對帳單",
    attachment: (a) => `${a.yyyy}-${a.mm}_永豐銀行綜合對帳單.pdf`,
    passwordProperty: "PWD_NATIONAL_ID",
  },
  {
    name: "台新信用卡",
    folder: "/archive/帳單/台新信用卡",
    query: "from:(webmaster@bhurecv.taishinbank.com.tw) subject:台新信用卡電子帳單",
    subject: "台新信用卡電子帳單\\s*(?<year>\\d{4})年(?<month>\\d{1,2})月",
    attachment: (a) =>
      /^TSB_Creditcard_Estatement_\d{6}\.pdf$/i.test(a.name)
        ? `${a.yyyy}-${a.mm}_台新信用卡帳單.pdf`
        : null,
    // 2024 年 12 月（113 年 12 月）帳單起改用新密碼，之前的帳單用身分證字號
    passwordProperty: (year, month) =>
      year * 100 + month >= 202412 ? "PWD_TAISHIN" : "PWD_NATIONAL_ID",
  },
  {
    name: "將來銀行對帳單",
    folder: "/archive/帳單/將來銀行對帳單",
    query: "from:(no_reply@eblsdr.nextbank.com.tw) subject:綜合對帳單",
    subject: "將來銀行通知】\\s*(?<year>\\d{4})年(?<month>\\d{1,2})月綜合對帳單",
    attachment: (a) => `${a.yyyy}-${a.mm}_將來銀行綜合對帳單.pdf`,
    passwordProperty: "PWD_NATIONAL_ID",
  },
  {
    name: "玉山信用卡",
    folder: "/archive/帳單/玉山信用卡",
    query: "from:(estatement@esunbank.com) subject:信用卡電子帳單",
    subject: "玉山銀行(?<year>\\d{4})年(?<month>\\d{1,2})月信用卡電子帳單",
    attachment: (a) => `${a.yyyy}-${a.mm}_玉山信用卡帳單.pdf`,
  },
  {
    name: "玉山銀行對帳單",
    folder: "/archive/帳單/玉山銀行對帳單",
    query: "from:(estatement@esunbank.com) subject:綜合對帳單",
    subject: "玉山銀行(?<year>\\d{4})年(?<month>\\d{1,2})月綜合對帳單",
    attachment: (a) => `${a.yyyy}-${a.mm}_玉山銀行綜合對帳單.pdf`,
    passwordProperty: "PWD_NATIONAL_ID",
  },
  {
    name: "永豐金證券對帳單",
    folder: "/archive/account/永豐證券台股對帳單",
    query: "from:(service@bhu.sinotrade.com.tw) subject:證券月對帳單",
    subject: "證券月對帳單",
    body: "附件為您(?<year>\\d{4})/(?<month>\\d{1,2})的證券月對帳單",
    attachment: (a) => `${a.yyyy}-${a.mm}_永豐金證券台股月對帳單.pdf`,
    passwordProperty: "PWD_NATIONAL_ID",
  },
  {
    name: "永豐金證券複委託對帳單",
    folder: "/archive/account/永豐證券美股對帳單",
    query: "from:(service@bhu.sinotrade.com.tw) subject:複委託月對帳單",
    subject: "複委託月對帳單",
    body: "附件為您(?<year>\\d{4})/(?<month>\\d{1,2})的複委託月對帳單",
    attachment: (a) => `${a.yyyy}-${a.mm}_永豐金證券複委託月對帳單.pdf`,
    passwordProperty: "PWD_NATIONAL_ID",
  },
];

// ===================== 主程式 =====================

/** Apps Script 單次執行上限 6 分鐘；超過此時間就不再開始處理新的郵件，留到下次執行 */
const MAX_RUNTIME_MS_ = 5 * 60 * 1000;

/**
 * 每家銀行找還沒有 PROCESSED_LABEL 的帳單郵件，逐封存檔（必要時解密），全部附件都有檔案才貼標籤。
 * 沒有符合附件的郵件也會貼上，避免每次都被重新處理（清理時仍會保留）。
 * 存檔或解密失敗只記錄錯誤，郵件沒貼標籤，下次執行會再試。
 */
async function runBillProcessor() {
  BANKS.forEach(validateBank_);
  const startTime = Date.now();
  const props = PropertiesService.getScriptProperties();
  const label =
    GmailApp.getUserLabelByName(PROCESSED_LABEL) ||
    (DRY_RUN ? null : GmailApp.createLabel(PROCESSED_LABEL));

  for (const bank of BANKS) {
    const query =
      `${bank.query} has:attachment filename:pdf -in:trash -in:drafts -in:spam ` +
      `-label:${PROCESSED_LABEL}`;
    const threads = GmailApp.search(query, 0, MAX_BATCH_SIZE).filter((t) =>
      matchesSubject_(bank, t)
    );
    let bankFolder = getFolderByPath_(bank.folder);

    for (const thread of threads) {
      if (Date.now() - startTime > MAX_RUNTIME_MS_) {
        console.warn("[時間不足] 剩下的郵件留到下次執行");
        return;
      }
      const subject = thread.getFirstMessageSubject();
      let pdfCount = 0;
      let allSaved = true;

      for (const msg of thread.getMessages()) {
        for (const { attachment, fileName, ym } of billFiles_(bank, thread, msg)) {
          pdfCount++;
          const status = bankFolder ? savedFileStatus_(bankFolder, fileName, msg.getId()) : "none";
          if (status === "saved") continue;
          if (status === "conflict") {
            allSaved = false;
            console.error(`[檔名衝突] ${bank.name}/${fileName} 已被其他郵件使用，請調整 attachment 的檔名`);
            continue;
          }

          const key = passwordPropertyFor_(bank, ym);
          const note = key ? `（用 ${key} 解密）` : "";
          if (DRY_RUN) {
            console.log(`[模擬存檔] ${bank.name}/${fileName}${note}`);
            allSaved = false;
            continue;
          }
          try {
            let bytes = attachment.getBytes();
            if (key) {
              const password = props.getProperty(key);
              if (password === null) throw new Error(`指令碼屬性 ${key} 未設定`);
              bytes = await decryptPdf_(bytes, password);
            }
            bankFolder = bankFolder || createFolderByPath_(bank.folder);
            bankFolder
              .createFile(Utilities.newBlob(bytes, "application/pdf", fileName))
              .setDescription(SOURCE_PREFIX_ + msg.getId());
            console.log(`[已存檔] ${bank.name}/${fileName}${note}`);
          } catch (e) {
            allSaved = false;
            console.error(`[存檔失敗] ${bank.name}/${fileName}${note}：${e}`);
          }
        }
      }

      if (!allSaved) {
        console.warn(`[未貼標籤] ${bank.name}：${subject}（尚未全部存檔，下次執行再試）`);
        continue;
      }
      const note = pdfCount === 0 ? "（沒有符合規則的附件）" : "";
      if (DRY_RUN) {
        console.log(`[模擬貼標籤] ${bank.name}：${subject}${note}`);
        continue;
      }
      thread.addLabel(label);
      console.log(`[已貼標籤] ${bank.name}：${subject}${note}`);
    }
  }
}

/** 檢查 subject 的具名群組：year 與 rocYear 不能並存，年與月必須同時出現 */
function validateBank_(bank) {
  if (!bank.folder) throw new Error(`${bank.name}：缺少 folder 設定`);
  if (bank.attachment && typeof bank.attachment !== "function") {
    throw new Error(`${bank.name}：attachment 必須是函式 (a) => 檔名 | null`);
  }
  for (const field of ["subject", "body"]) {
    const pattern = bank[field];
    const hasYear = /\(\?<year>/.test(pattern);
    const hasRocYear = /\(\?<rocYear>/.test(pattern);
    const hasMonth = /\(\?<month>/.test(pattern);
    if (hasYear && hasRocYear) {
      throw new Error(`${bank.name}：${field} 不能同時包含 (?<year>...) 與 (?<rocYear>...)`);
    }
    if ((hasYear || hasRocYear) !== hasMonth) {
      throw new Error(`${bank.name}：${field} 需同時包含年 (?<year>/(?<rocYear>) 與 (?<month>...)`);
    }
  }
}

/** thread 的第一封郵件標題是否符合 bank.subject（未設定則一律符合） */
function matchesSubject_(bank, thread) {
  return !bank.subject || new RegExp(bank.subject).test(thread.getFirstMessageSubject());
}

/**
 * 郵件中要存檔的 PDF 附件與目標檔名 [{ attachment, fileName, ym }]。
 * 未設定 bank.attachment 時處理所有 PDF，使用預設檔名 <yyyy-MM>_<附件名去副檔名>_<message.id>.pdf；
 * 設定為函式時，每個 PDF 附件呼叫一次，回傳檔名表示存檔（沒有 .pdf 會自動補上），回傳 null 表示略過。
 * 檔名是檢查「是否已存檔」的依據，處理與清理都由此取得，同一封郵件每次必須得到相同的檔名。
 */
function billFiles_(bank, thread, msg) {
  const pdfs = msg.getAttachments().filter((a) => /\.pdf$/i.test(a.getName()));
  if (pdfs.length === 0) return [];
  const ym = billYearMonth_(bank, thread, msg);
  const mm = String(ym.month).padStart(2, "0");
  const files = [];
  for (const attachment of pdfs) {
    const name = attachment.getName();
    const base = name.replace(/\.pdf$/i, "");
    const defaultName = `${ym.year}${mm}_${base}_${msg.getId()}.pdf`;
    let fileName = defaultName;
    if (bank.attachment) {
      fileName = bank.attachment({
        name,
        base,
        yyyy: String(ym.year),
        m: String(ym.month),
        mm,
        messageId: msg.getId(),
        subject: thread.getFirstMessageSubject(),
        defaultName,
      });
      if (!fileName) continue;
      if (!/\.pdf$/i.test(fileName)) fileName += ".pdf";
    }
    files.push({ attachment, fileName, ym });
  }
  return files;
}

/**
 * 帳單年月 { year, month }（數字），依序採用：
 *   1. thread 第一封郵件標題符合 bank.subject 的具名群組
 *   2. 該封郵件內文（純文字）符合 bank.body 的具名群組
 *   3. 該封郵件的寄送時間（UTC+8）
 * 檔名與 passwordProperty 函式都用這個年月。
 */
function billYearMonth_(bank, thread, msg) {
  return (
    yearMonthFromText_(bank.subject, thread.getFirstMessageSubject()) ||
    yearMonthFromText_(bank.body, bank.body ? msg.getPlainBody() : "") || {
      year: Number(Utilities.formatDate(msg.getDate(), "GMT+8", "yyyy")),
      month: Number(Utilities.formatDate(msg.getDate(), "GMT+8", "M")),
    }
  );
}

/** 用 pattern 的具名群組 year/rocYear 與 month 從 text 取年月；沒設定、沒比對到或群組為空時回傳 null */
function yearMonthFromText_(pattern, text) {
  const match = pattern && new RegExp(pattern).exec(text);
  const groups = (match && match.groups) || {};
  const year = groups.rocYear ? Number(groups.rocYear) + 1911 : Number(groups.year);
  const month = Number(groups.month);
  return year && month >= 1 && month <= 12 ? { year, month } : null;
}

/** 這份帳單要用的密碼屬性名稱；null 表示 PDF 未加密 */
function passwordPropertyFor_(bank, ym) {
  const p = bank.passwordProperty;
  return (typeof p === "function" ? p(ym.year, ym.month) : p) || null;
}

// ===================== 解密 =====================

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

// ===================== Drive =====================

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

/** 依路徑找資料夾，不存在的層級會建立 */
function createFolderByPath_(path) {
  let folder = DriveApp.getRootFolder();
  for (const name of path.split("/").filter(Boolean)) {
    const it = folder.getFoldersByName(name);
    folder = it.hasNext() ? it.next() : folder.createFolder(name);
  }
  return folder;
}

/** 資料夾中是否有此檔名、且不在垃圾桶的檔案（getFilesByName 也會找到垃圾桶裡的檔案） */
/** 存檔時寫進 Drive 檔案說明的來源郵件 ID，用來分辨同名檔案是不是這封郵件存的 */
const SOURCE_PREFIX_ = "gmail-message-id:";

/**
 * 資料夾中此檔名（不在垃圾桶；getFilesByName 也會找到垃圾桶裡的檔案）的狀態：
 *   "none"     沒有檔案
 *   "saved"    已由這封郵件存檔（說明欄沒有來源 ID 的舊檔也視為已存檔）
 *   "conflict" 只有其他郵件存的同名檔案
 */
function savedFileStatus_(folder, fileName, messageId) {
  let status = "none";
  const it = folder.getFilesByName(fileName);
  while (it.hasNext()) {
    const file = it.next();
    if (file.isTrashed()) continue;
    const description = file.getDescription() || "";
    if (!description.startsWith(SOURCE_PREFIX_)) return "saved";
    if (description === SOURCE_PREFIX_ + messageId) return "saved";
    status = "conflict";
  }
  return status;
}

// ===================== 清理 =====================

/**
 * 只有當郵件中每個符合規則的 PDF 附件都在 Drive 找到對應的檔案時，才把整串郵件移到垃圾桶。
 * 沒處理成功的信（例如密碼錯誤）會被保留下來。
 */
function cleanupProcessedThreads() {
  BANKS.forEach((bank) => {
    const query =
      `${bank.query} has:attachment filename:pdf -in:trash label:${PROCESSED_LABEL} ` +
      `older_than:${CLEANUP_AFTER_DAYS}d`;
    const threads = GmailApp.search(query, 0, 50).filter((t) => matchesSubject_(bank, t));
    const bankFolder = getFolderByPath_(bank.folder);

    threads.forEach((thread) => {
      const subject = thread.getFirstMessageSubject();
      if (!bankFolder || !hasAllFiles_(bank, thread, bankFolder)) {
        console.warn(`[保留] ${bank.name}：${subject}（Drive 中找不到完整的檔案）`);
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

/** thread 至少有一個符合規則的附件，且每個都在銀行資料夾找得到由該郵件存的檔案 */
function hasAllFiles_(bank, thread, bankFolder) {
  let pdfCount = 0;
  const allSaved = thread.getMessages().every((msg) =>
    billFiles_(bank, thread, msg).every(({ fileName }) => {
      pdfCount++;
      return savedFileStatus_(bankFolder, fileName, msg.getId()) === "saved";
    })
  );
  return pdfCount > 0 && allSaved;
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
