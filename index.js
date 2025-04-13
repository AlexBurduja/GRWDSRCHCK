// index.js — COMPLET cu retry, timeout, salvare persistentă și filtrare mesaje duble
require("dotenv").config();

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
const GIST_ID = process.env.GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const COOKIE_FILE = "./cookies.json";
const META_FILE = "./cookie_meta.json";
const NOTES_FILE = "./previous_notes.json";

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

// retry helper
async function withRetry(fn, retries = 3, delay = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      console.warn(`⚠️ Retry ${i} eșuat: ${err.message}. Reîncercăm în ${delay / 1000}s...`);
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

function savePreviousNotes(notes) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

function loadPreviousNotes() {
  if (fs.existsSync(NOTES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(NOTES_FILE, "utf8"));
    } catch (e) {
      console.error("❌ Eroare la citirea previous_notes.json:", e.message);
    }
  }
  return [];
}

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

  console.log("🔍 Încercăm descărcarea din Gist...");
  return downloadFromGist();
}

async function uploadToGist(content) {
  if (!GIST_ID || !GITHUB_TOKEN) return;
  try {
    await axios.patch(
      `https://api.github.com/gists/${GIST_ID}`,
      {
        files: {
          "cookies.json": { content },
        },
      },
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
        },
      }
    );
    console.log("📤 Cookie uploadat în GitHub Gist!");
  } catch (err) {
    console.error("❌ Eroare la upload în Gist:", err.message);
  }
}

async function downloadFromGist() {
  if (!GIST_ID || !GITHUB_TOKEN) return null;
  try {
    const res = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
    });
    const content = res.data.files["cookies.json"].content;
    fs.writeFileSync(COOKIE_FILE, content);
    console.log("📥 Cookie descărcat din GitHub Gist!");
    return tough.CookieJar.deserializeSync(JSON.parse(content));
  } catch (err) {
    console.error("❌ Eroare la descărcare din Gist:", err.message);
    return new tough.CookieJar();
  }
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

  await uploadToGist(raw);
  await sendTelegram(`📦 Cookie regenerat după 2FA. A fost sincronizat automat în Gist.`);
}

async function login(force = false) {
  const jar = await loadCookies();
  globalCookieJar = jar;
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 10000,
  }));

  if (!force) {
    try {
      const test = await client.get(TARGET_URL);
      if (!test.data.includes("TextBoxPass") && !test.data.includes("Autentificare esuata")) {
        console.log("✅ Folosim sesiunea salvată.");
        return { client };
      }
    } catch (e) {
      console.warn("⚠️ Test GET a eșuat. Relogin necesar.", e.message);
    }
  }

  const loginPage = await client.get(LOGIN_URL);
  let $ = cheerio.load(loginPage.data);
  const payload = {
    __VIEWSTATE: $("#__VIEWSTATE").val(),
    __VIEWSTATEGENERATOR: $("#__VIEWSTATEGENERATOR").val(),
    __EVENTVALIDATION: $("#__EVENTVALIDATION").val(),
    __EVENTTARGET: "",
    __EVENTARGUMENT: "",
    Hidden_ClientJS: $("#Hidden_ClientJS").val() || "",
    TextBoxUser: USERNAME,
    TextBoxPass: PASSWORD,
    ButtonLogin: "Autentificare",
  };

  let response = await client.post(LOGIN_URL, qs.stringify(payload), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: LOGIN_URL,
      Origin: BASE_URL,
    },
  });

  if (response.data.includes("TextBoxCode")) {
    console.log("📩 Cod 2FA necesar – aștept prin Telegram...");
    await sendTelegram("📩 Cod 2FA necesar. Trimite-l cu comanda: /2fa CODUL_TAU");

    pending2FA = true;

    return await new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(async () => {
        await sendTelegram("⏱️ Timpul de 10 minute pentru 2FA a expirat. Botul se va opri.");
        process.exit(1);
      }, 10 * 60 * 1000);

      resumeLoginAfter2FA = async (code) => {
        const $$ = cheerio.load(response.data);
        const codePayload = {
          __VIEWSTATE: $$("#__VIEWSTATE").val(),
          __VIEWSTATEGENERATOR: $$("#__VIEWSTATEGENERATOR").val(),
          __EVENTVALIDATION: $$("#__EVENTVALIDATION").val(),
          __EVENTTARGET: "",
          __EVENTARGUMENT: "",
          Hidden_ClientJS: $$("#Hidden_ClientJS").val() || "",
          TextBoxCode: code,
          CheckBoxDevice: "on",
          ButtonLogin: "Autentificare",
        };

        const finalResponse = await client.post(LOGIN_URL, qs.stringify(codePayload), {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: LOGIN_URL,
            Origin: BASE_URL,
          },
        });

        if (finalResponse.data.includes("TextBoxPass")) {
          await sendTelegram("❌ Cod 2FA incorect sau autentificare eșuată.");
          throw new Error("Autentificare eșuată după 2FA");
        }

        clearTimeout(timeoutHandle);
        await sendTelegram("✅ Autentificare reușită după 2FA!");
        saveCookies(jar);
        resolve({ client });
      };
    });
  }

  if (response.data.includes("TextBoxPass")) throw new Error("❌ Autentificare eșuată.");

  console.log("✅ Autentificare reușită!");
  saveCookies(jar);
  return { client };
}

async function fetchTableData(client, retry = true) {
  const response = await client.get(TARGET_URL);
  const $ = cheerio.load(response.data);

  const table = $("#ctl00_ContentPlaceHolderMain_TabContainer_MAIN_TabPanel_APPROVAL_LIST_GridViewApprovalList");
  if (!table.length) {
    console.warn("❌ Table not found.");
    if (retry) {
      console.log("🔁 Reîncercăm după login forțat...");
      const result = await login(true);
      globalClient = result.client;
      return await fetchTableData(globalClient, false);
    }
    return [];
  }

  const rows = table.find("tr").slice(1);
  const notes = [];

  rows.each((_, row) => {
    const $row = $(row);
    const tds = $row.find("td");
    const noteId = tds.eq(1).text().trim();

    const bgcolorAttr = $row.attr("bgcolor")?.toLowerCase() || "";
    const isYellow = bgcolorAttr === "#fff3cd";

    notes.push({ id: noteId, isYellow });
  });

  return notes;
}

// checkNotes cu retry
async function checkNotes() {
  console.log("🧠 Pornire checkNotes()...");
  if (!globalClient) globalClient = (await login()).client;

  const notes = await withRetry(() => fetchTableData(globalClient), 3, 10000);
  const currentNoteCount = notes.length;
  console.log(`🧾 Fișiere detectate: ${currentNoteCount}`);

  previousNotes = loadPreviousNotes();
  const currentIds = notes.map((n) => n.id);
  const previousIds = previousNotes.map((n) => n.id);

  const newOnes = notes.filter((n) => !previousIds.includes(n.id));
  const disappeared = previousNotes.filter((n) => !currentIds.includes(n.id));

  const yellowNow = notes.filter(n => n.isYellow).map(n => n.id);
  const yellowBefore = previousNotes.filter(n => n.isYellow).map(n => n.id);

  const turnedYellow = notes.filter(n => n.isYellow && !yellowBefore.includes(n.id) && previousIds.includes(n.id));
  const becameNormal = yellowBefore.filter(id => !yellowNow.includes(id));

  if (newOnes.length > 0) {
    await sendTelegram(`📥 S-au adăugat ${newOnes.length} fișier(e):\n${newOnes.map((n) => n.isYellow ? `🟡 ${n.id}` : n.id).join("\n")}\n\nTotal: ${currentNoteCount}`);
  }

  if (disappeared.length > 0) {
    await sendTelegram(`🗑️ Au dispărut ${disappeared.length} fișier(e):\n${disappeared.map((n) => n.isYellow ? `🟡 ${n.id}` : n.id).join("\n")}\n\nTotal: ${currentNoteCount}`);
  }

  if (turnedYellow.length > 0) {
    await sendTelegram(`🟡 ${turnedYellow.length} fișier(e) au devenit cu fundal galben:\n${turnedYellow.map(n => n.id).join("\n")}\n\nTotal: ${currentNoteCount}`);
  }

  if (becameNormal.length > 0) {
    await sendTelegram(`✅ ${becameNormal.length} fișier(e) nu mai sunt galbene:\n${becameNormal.join("\n")}\n\nTotal: ${currentNoteCount}`);
  }

  previousNoteCount = currentNoteCount;
  previousNotes = notes;
  savePreviousNotes(notes);
}

// START MONITORING - modificat
(async () => {
  console.log("🔁 Monitor activ.");
  try {
    await checkNotes();
  } catch (err) {
    console.error("💥 Eroare inițială:", err.message);
  }

  setInterval(async () => {
    try {
      console.log("⏰ Verificare periodică...");
      await checkNotes();
    } catch (err) {
      console.error("💥 Eroare la verificarea periodică:", err.message);
    }
  }, 60_000);
})();