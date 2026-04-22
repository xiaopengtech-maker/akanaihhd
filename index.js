/**
 * index.js
 * MB Bank -> Telegram notifier PRO
 * Node.js 18+
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

// ================= CONFIG =================
const BOT_TOKEN =
  process.env.BOT_TOKEN || "8212240850:AAERUllcs3Sye3mHM1FwMiVDM_O4JG0Pz4E";

const CHAT_ID = process.env.CHAT_ID || "-1003910243518";

const API_URL =
  process.env.API_URL ||
  "https://thueapibank.com/historyapimbbank/529ac6b9fec7758cff3209ebd864e180";

const PORT = Number(process.env.PORT || 3000);

// thời gian check API
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 4000);

// delay giữa mỗi tin nhắn telegram
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 1200);

// số lần retry gửi telegram
const TELEGRAM_RETRY = Number(process.env.TELEGRAM_RETRY || 5);

// delay retry ban đầu
const TELEGRAM_RETRY_DELAY_MS = Number(
  process.env.TELEGRAM_RETRY_DELAY_MS || 1500
);

// chỉ giữ lại N ref gần nhất để file state không phình quá
const MAX_SEEN = Number(process.env.MAX_SEEN || 5000);

// nếu có nhiều giao dịch mới cùng lúc thì gom vào 1 tin
const BATCH_MODE = String(process.env.BATCH_MODE || "true") === "true";

// giới hạn ký tự tránh quá dài
const TELEGRAM_MAX_LENGTH = 3900;

const STATE_FILE = path.join(__dirname, "seen.json");

// ================= STATE =================
let seenSet = new Set();
let seenList = [];
let firstRun = true;
let checking = false;
let queue = Promise.resolve();
let lastCheckAt = null;
let lastSuccessAt = null;
let totalSent = 0;
let totalErrors = 0;

// ================= HELPERS =================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowISO() {
  return new Date().toISOString();
}

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatMoney(x) {
  const n = Number(String(x || "0").replace(/[^\d.-]/g, ""));
  if (Number.isNaN(n)) return `${x} VND`;
  return n.toLocaleString("vi-VN") + " VND";
}

function trimText(s = "", max = 800) {
  s = String(s || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function getRefNo(tx) {
  return String(tx?.refNo || "").trim();
}

function normalizeTransactions(list) {
  if (!Array.isArray(list)) return [];

  return list
    .filter((tx) => tx && getRefNo(tx))
    .map((tx) => ({
      refNo: getRefNo(tx),
      accountNo: tx.accountNo || "",
      creditAmount: tx.creditAmount || "0",
      debitAmount: tx.debitAmount || "0",
      description: tx.description || "",
      transactionDate: tx.transactionDate || "",
      postingDate: tx.postingDate || "",
      currency: tx.currency || "VND",
      raw: tx,
    }));
}

function addSeen(refNo) {
  if (!refNo || seenSet.has(refNo)) return;
  seenSet.add(refNo);
  seenList.push(refNo);

  if (seenList.length > MAX_SEEN) {
    const extra = seenList.length - MAX_SEEN;
    const removed = seenList.splice(0, extra);
    for (const r of removed) seenSet.delete(r);
  }
}

function hasSeen(refNo) {
  return seenSet.has(refNo);
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      console.log("[STATE] chưa có seen.json");
      return;
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      seenList = parsed.filter(Boolean).map(String);
      seenSet = new Set(seenList);
      console.log(`[STATE] loaded ${seenList.length} ref`);
      return;
    }

    if (parsed && Array.isArray(parsed.refs)) {
      seenList = parsed.refs.filter(Boolean).map(String);
      seenSet = new Set(seenList);
      console.log(`[STATE] loaded ${seenList.length} ref`);
    }
  } catch (err) {
    console.log("[STATE] load error:", err.message);
  }
}

function saveState() {
  try {
    const payload = {
      refs: seenList,
      updatedAt: nowISO(),
      total: seenList.length,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    console.log("[STATE] save error:", err.message);
  }
}

function buildSingleMessage(tx) {
  const amount =
    Number(tx.creditAmount || 0) > 0
      ? formatMoney(tx.creditAmount)
      : Number(tx.debitAmount || 0) > 0
      ? "-" + formatMoney(tx.debitAmount)
      : "0 VND";

  return [
    "💸 <b>Giao dịch mới</b>",
    "",
    `Tài Khoản : <code>${esc(tx.accountNo || "Không rõ")}</code>`,
    `Số Tiền : <b>${esc(amount)}</b>`,
    `Nội Dung : ${esc(trimText(tx.description || "Không có", 1200))}`,
    `Ngày Giờ : ${esc(tx.transactionDate || tx.postingDate || "Không rõ")}`,
    `Mã GD : <code>${esc(tx.refNo)}</code>`,
  ].join("\n");
}

function buildBatchMessage(list) {
  const lines = [];
  lines.push(`💸 <b>Có ${list.length} giao dịch mới</b>`);
  lines.push("");

  list.forEach((tx, i) => {
    const amount =
      Number(tx.creditAmount || 0) > 0
        ? formatMoney(tx.creditAmount)
        : Number(tx.debitAmount || 0) > 0
        ? "-" + formatMoney(tx.debitAmount)
        : "0 VND";

    lines.push(`<b>${i + 1}.</b>`);
    lines.push(`Tài Khoản : <code>${esc(tx.accountNo || "Không rõ")}</code>`);
    lines.push(`Số Tiền : <b>${esc(amount)}</b>`);
    lines.push(`Nội Dung : ${esc(trimText(tx.description || "Không có", 500))}`);
    lines.push(
      `Ngày Giờ : ${esc(tx.transactionDate || tx.postingDate || "Không rõ")}`
    );
    lines.push(`Mã GD : <code>${esc(tx.refNo)}</code>`);
    lines.push("");
  });

  let msg = lines.join("\n");
  if (msg.length > TELEGRAM_MAX_LENGTH) {
    msg =
      msg.slice(0, TELEGRAM_MAX_LENGTH - 50) +
      "\n\n<i>... còn tiếp, tin nhắn đã được rút gọn</i>";
  }
  return msg;
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || !data || !data.ok) {
    const errMsg = data ? JSON.stringify(data) : `${res.status} ${res.statusText}`;
    throw new Error(`Telegram send failed: ${errMsg}`);
  }

  return data;
}

async function sendWithRetry(text) {
  let attempt = 0;
  let delay = TELEGRAM_RETRY_DELAY_MS;

  while (attempt < TELEGRAM_RETRY) {
    try {
      attempt++;
      await sendTelegram(text);
      return true;
    } catch (err) {
      console.log(`[TG] attempt ${attempt}/${TELEGRAM_RETRY} failed: ${err.message}`);
      if (attempt >= TELEGRAM_RETRY) throw err;
      await sleep(delay);
      delay *= 2;
    }
  }

  return false;
}

function enqueue(taskFn) {
  queue = queue
    .then(() => taskFn())
    .catch((err) => {
      totalErrors++;
      console.log("[QUEUE] error:", err.message);
    });
  return queue;
}

async function processNotifications(newTxs) {
  if (!newTxs.length) return;

  // gửi từ cũ -> mới
  newTxs = [...newTxs].reverse();

  if (BATCH_MODE && newTxs.length > 1) {
    await enqueue(async () => {
      const msg = buildBatchMessage(newTxs);
      await sendWithRetry(msg);
      totalSent += newTxs.length;
      console.log(`[SEND] batch sent ${newTxs.length} tx`);
      await sleep(SEND_DELAY_MS);
    });
    return;
  }

  for (const tx of newTxs) {
    await enqueue(async () => {
      const msg = buildSingleMessage(tx);
      await sendWithRetry(msg);
      totalSent++;
      console.log(`[SEND] sent ${tx.refNo}`);
      await sleep(SEND_DELAY_MS);
    });
  }
}

async function fetchTransactions() {
  const res = await fetch(API_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 MB-Telegram-Bot",
      "Cache-Control": "no-cache",
    },
  });

  if (!res.ok) {
    throw new Error(`API ${res.status} ${res.statusText}`);
  }

  const json = await res.json();

  if (!json || json.status !== "success" || !Array.isArray(json.TranList)) {
    throw new Error("API trả về sai định dạng");
  }

  return normalizeTransactions(json.TranList);
}

async function check() {
  if (checking) {
    console.log("[CHECK] skip vì đang check dở");
    return;
  }

  checking = true;
  lastCheckAt = nowISO();

  try {
    const list = await fetchTransactions();

    if (!list.length) {
      console.log("[CHECK] không có giao dịch");
      return;
    }

    if (firstRun) {
      for (const tx of list) addSeen(tx.refNo);
      saveState();
      firstRun = false;
      lastSuccessAt = nowISO();
      console.log(`[INIT] đã ghi nhớ ${list.length} giao dịch cũ, không gửi lại`);
      return;
    }

    const newTxs = list.filter((tx) => !hasSeen(tx.refNo));

    if (!newTxs.length) {
      lastSuccessAt = nowISO();
      console.log("[CHECK] không có giao dịch mới");
      return;
    }

    // đánh dấu seen trước để tránh bị gửi lại khi check tiếp theo tới quá nhanh
    for (const tx of newTxs) addSeen(tx.refNo);
    saveState();

    console.log(`[CHECK] phát hiện ${newTxs.length} giao dịch mới`);

    await processNotifications(newTxs);

    lastSuccessAt = nowISO();
  } catch (err) {
    totalErrors++;
    console.log("[CHECK] error:", err.message);
  } finally {
    checking = false;
  }
}

// ================= SERVER FOR RENDER =================
const server = http.createServer((req, res) => {
  const body = {
    ok: true,
    service: "mb-telegram-bot",
    time: nowISO(),
    lastCheckAt,
    lastSuccessAt,
    queuePending: "internal",
    seen: seenList.length,
    totalSent,
    totalErrors,
    intervalMs: CHECK_INTERVAL_MS,
  };

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
});

// ================= START =================
function validateConfig() {
  if (!BOT_TOKEN || !CHAT_ID || !API_URL) {
    console.log("[FATAL] thiếu BOT_TOKEN / CHAT_ID / API_URL");
    process.exit(1);
  }
}

async function start() {
  validateConfig();
  loadState();

  server.listen(PORT, () => {
    console.log(`[HTTP] listening on port ${PORT}`);
  });

  console.log("[BOT] started");
  console.log("[BOT] API_URL =", API_URL);
  console.log("[BOT] CHAT_ID =", CHAT_ID);
  console.log("[BOT] CHECK_INTERVAL_MS =", CHECK_INTERVAL_MS);
  console.log("[BOT] SEND_DELAY_MS =", SEND_DELAY_MS);
  console.log("[BOT] TELEGRAM_RETRY =", TELEGRAM_RETRY);
  console.log("[BOT] BATCH_MODE =", BATCH_MODE);

  await check();
  setInterval(check, CHECK_INTERVAL_MS);
}

start().catch((err) => {
  console.log("[FATAL]", err.message);
  process.exit(1);
});

// ================= GRACEFUL SHUTDOWN =================
async function shutdown(signal) {
  try {
    console.log(`[EXIT] ${signal} received, saving state...`);
    saveState();
    server.close(() => {
      console.log("[EXIT] http server closed");
      process.exit(0);
    });

    setTimeout(() => {
      console.log("[EXIT] force exit");
      process.exit(0);
    }, 5000);
  } catch (err) {
    console.log("[EXIT] error:", err.message);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  totalErrors++;
  console.log("[uncaughtException]", err.message);
});
process.on("unhandledRejection", (reason) => {
  totalErrors++;
  console.log("[unhandledRejection]", String(reason));
});
