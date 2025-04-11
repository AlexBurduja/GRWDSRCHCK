// index.js — versiunea completă actualizată

const axios = require("axios");
const cheerio = require("cheerio");
const qs = require("qs");
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const express = require("express");
const fs = require("fs");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_URL = "https://grawe.native-code.ro";
const LOGIN_URL = `${BASE_URL}/login.aspx`;
const TARGET_URL = `${BASE_URL}/content/files/check/file_list_check_client.aspx`;
const USERNAME = process.env.LOGIN_USERNAME;
const PASSWORD = process.env.LOGIN_PASSWORD;

const COOKIE_FILE = "./cookies.json";
const META_FILE = "./cookie_meta.json";

let previousNotes = [];
let previousNoteCount = 0;
let pending2FA = false;
let saved2FACode = null;
let resumeLoginAfter2FA = null;
let timeoutHandle = null;

let globalClient = null;
let globalCookieJar = null;

const app = express();
const PORT = 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Botul este activ.");
});

app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/test") {
    await sendTelegram("✅ Botul funcționează corect!", chatId);
  }

  if (text === "/status") {
    await sendTelegram(`📊 Fișiere detectate: ${previousNoteCount}`, chatId);
  }

  if (text === "/check") {
    if (fs.existsSync(META_FILE)) {
      const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
      const loginDate = new Date(meta.loginDate);
      const now = new Date();
      const diffMs = now - loginDate;
      const daysPassed = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      const daysLeft = Math.max(0, 30 - daysPassed);

      await sendTelegram(`📅 Cod 2FA folosit acum ${daysPassed} zile.\n⏳ Mai sunt ${daysLeft} zile până expiră.`, chatId);
    } else {
      await sendTelegram("⚠️ Nu există informații despre 2FA. Probabil urmează autentificarea.", chatId);
    }
  }

  if (text.startsWith("/2fa ")) {
    const code = text.split(" ")[1];
    if (code && resumeLoginAfter2FA) {
      clearTimeout(timeoutHandle);
      saved2FACode = code;
      pending2FA = false;
      await sendTelegram("🔐 Cod 2FA primit. Continuăm autentificarea...", chatId);
      resumeLoginAfter2FA(code);
    } else {
      await sendTelegram("⚠️ Nu a fost solicitat un cod 2FA sau codul este invalid.", chatId);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Express server is running on port ${PORT}`);
});

async function sendTelegram(msg, chatId = TELEGRAM_CHAT_ID) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: msg,
    });
  } catch (error) {
    console.log("Error sending Telegram message:", error.message);
  }
}

function loadCookies() {
  if (fs.existsSync(COOKIE_FILE)) {
    console.log("🍪 Cookie încărcat din cookies.json");
    const raw = fs.readFileSync(COOKIE_FILE, "utf8");
    return tough.CookieJar.deserializeSync(JSON.parse(raw));
  }

  if (process.env.COOKIES_JSON) {
    console.log("📦 Cookie încărcat din env (COOKIES_JSON)");
    const raw = Buffer.from(process.env.COOKIES_JSON, "base64").toString("utf8");
    fs.writeFileSync(COOKIE_FILE, raw);
    return tough.CookieJar.deserializeSync(JSON.parse(raw));
  }

  console.log("⚠️ Niciun cookie găsit. Se va cere 2FA.");
  return new tough.CookieJar();
}

async function saveCookies(jar) {
  const serialized = jar.serializeSync();
  const raw = JSON.stringify(serialized);
  const encoded = Buffer.from(raw).toString("base64");

  fs.writeFileSync(COOKIE_FILE, raw);
  console.log("💾 Cookie salvat în cookies.json");

  const now = new Date().toISOString();
  fs.writeFileSync(META_FILE, JSON.stringify({ loginDate: now }));
  console.log("🗓️ Dată 2FA salvată:", now);

  await sendTelegram(`📦 Cookie a fost regenerat după login 2FA.\n(opțional: dacă vrei să persiști sesiunea între redeploy-uri, poți salva asta ca secret în Railway)\n\nCOOKIES_JSON=${encoded}`);
}
