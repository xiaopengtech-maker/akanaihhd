const axios = require("axios");
const JSZip = require("jszip");
const FormData = require("form-data");
const express = require("express");

const app = express();

// ===== CONFIG =====
const API_URL = "https://thueapibank.com/historyapimbbank/529ac6b9fec7758cff3209ebd864e180";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const TELEGRAM_SEND = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
const TELEGRAM_DOC = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;

let lastRefs = new Set();
let lastStatus = "Starting...";

// ===== RANDOM DELAY =====
function randomDelay() {
  return Math.floor(Math.random() * 10000) + 25000; // 25–35s
}

// ===== FETCH =====
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, {
        timeout: 10000,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json"
        }
      });
    } catch (e) {
      if (e.response?.status === 429) {
        console.log("429 → sleep 60s");
        await new Promise(r => setTimeout(r, 60000));
      }
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ===== CHECK =====
async function check() {
  try {
    const res = await fetchWithRetry(API_URL);
    const data = res.data;

    if (data.status !== "success") {
      lastStatus = "API lỗi";
      return;
    }

    const list = data.TranList;
    if (!list || list.length === 0) return;

    for (const tran of list) {
      if (lastRefs.has(tran.refNo)) continue;

      lastRefs.add(tran.refNo);

      const message = `💰 GIAO DỊCH MỚI

Tài khoản : ${tran.accountNo}
Đã Nhận : ${tran.creditAmount} ${tran.currency}
Nội Dung : ${tran.description}
Ngày Giờ : ${tran.transactionDate}`;

      const zip = new JSZip();
      zip.file("transaction.txt", message);
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

      await axios.post(TELEGRAM_SEND, {
        chat_id: CHAT_ID,
        text: message,
      });

      const formData = new FormData();
      formData.append("chat_id", CHAT_ID);
      formData.append("document", zipBuffer, "transaction.zip");

      await axios.post(TELEGRAM_DOC, formData, {
        headers: formData.getHeaders(),
      });

      lastStatus = "Đã gửi: " + tran.refNo;
      console.log("Sent:", tran.refNo);
    }

  } catch (e) {
    lastStatus = e.response ? "HTTP " + e.response.status : e.message;
    console.log(lastStatus);
  }
}

// ===== LOOP =====
async function loop() {
  await check();
  setTimeout(loop, randomDelay());
}
loop();

// ===== API TEST =====
app.get("/api/test", async (req, res) => {
  try {
    const response = await fetchWithRetry(API_URL);
    res.json(response.data);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ===== TEST TELEGRAM =====
app.get("/api/send-test", async (req, res) => {
  try {
    const message = `🧪 TEST BOT OK

Tài khoản : TEST
Đã Nhận : 123456 VND
Nội Dung : test telegram
Ngày Giờ : ${new Date().toLocaleString()}`;

    const zip = new JSZip();
    zip.file("test.txt", message);
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    await axios.post(TELEGRAM_SEND, {
      chat_id: CHAT_ID,
      text: message,
    });

    const formData = new FormData();
    formData.append("chat_id", CHAT_ID);
    formData.append("document", zipBuffer, "test.zip");

    await axios.post(TELEGRAM_DOC, formData, {
      headers: formData.getHeaders(),
    });

    res.json({ success: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ===== DASHBOARD =====
app.get("/", (req, res) => {
  res.send(`
  <html>
  <head>
    <title>Bot Monitor</title>
    <style>
      body { font-family: Arial; background: #0f172a; color: #fff; text-align: center; padding: 40px; }
      .box { background: #1e293b; padding: 20px; border-radius: 10px; display: inline-block; }
      button { padding: 10px 20px; margin: 5px; border: none; border-radius: 5px; background: #22c55e; color: white; cursor: pointer; }
      pre { text-align: left; background: black; padding: 10px; overflow: auto; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>🤖 Bot Status</h1>
      <p>${lastStatus}</p>

      <button onclick="testAPI()">Test API</button>
      <button onclick="sendTest()">Test Telegram</button>

      <pre id="result"></pre>
    </div>

    <script>
      async function testAPI() {
        document.getElementById("result").innerText = "Loading...";
        const res = await fetch('/api/test');
        const data = await res.json();
        document.getElementById("result").innerText = JSON.stringify(data, null, 2);
      }

      async function sendTest() {
        document.getElementById("result").innerText = "Sending...";
        const res = await fetch('/api/send-test');
        const data = await res.json();
        document.getElementById("result").innerText = JSON.stringify(data, null, 2);
      }

      setInterval(() => location.reload(), 10000);
    </script>
  </body>
  </html>
  `);
});

// ===== SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
