/**
 * 設定檔：使用者主要修改的地方
 *   - 下方常數控制模擬模式、標籤、批次大小與清理時間
 *   - BANKS 每筆對應一種帳單；密碼存在「專案設定 > 指令碼屬性」，屬性名稱對應 passwordProperty
 * 程式邏輯在 processor.js（Apps Script 所有檔案共用全域範圍）。
 */

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
 *                     檔名是判斷「已存檔」的依據，必須能區分不同郵件（例如含年月或 messageId），否則後來的會記錄檔名衝突且不貼標籤。例：
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
