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

function saveCookies(jar) {
  const serialized = jar.serializeSync();
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(serialized));
  console.log("💾 Cookie salvat în cookies.json");
}

function loadCookies() {
  if (!fs.existsSync(COOKIE_FILE)) return new tough.CookieJar();
  const raw = fs.readFileSync(COOKIE_FILE, "utf8");
  return tough.CookieJar.deserializeSync(JSON.parse(raw));
}

async function login(force = false) {
  const jar = loadCookies();
  globalCookieJar = jar;
  const client = wrapper(axios.create({ jar, withCredentials: true }));

  if (!force) {
    try {
      const test = await client.get(TARGET_URL);
      if (!test.data.includes("TextBoxPass") && !test.data.includes("Autentificare esuata")) {
        console.log("✅ Folosim sesiunea salvată.");
        return { client };
      }
    } catch (e) {
      console.warn("Test GET failed, relogin necesar.", e.message);
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
    await sendTelegram("📩 Cod 2FA necesar. Trimite cu: /2fa CODUL_TAU");

    pending2FA = true;

    return await new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(async () => {
        await sendTelegram("⏱️ Cod 2FA nu a fost primit în 10 minute. Botul se oprește.");
        process.exit(1);
      }, 10 * 60 * 1000);

      resumeLoginAfter2FA = async (code) => {
        const $$ = cheerio.load(response.data);
        const codePayload = {
          __VIEWSTATE: $$("input#__VIEWSTATE").val(),
          __VIEWSTATEGENERATOR: $$("input#__VIEWSTATEGENERATOR").val(),
          __EVENTVALIDATION: $$("input#__EVENTVALIDATION").val(),
          __EVENTTARGET: "",
          __EVENTARGUMENT: "",
          Hidden_ClientJS: $$("input#Hidden_ClientJS").val() || "",
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
          await sendTelegram("❌ Cod 2FA incorect.");
          throw new Error("2FA greșit.");
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
    const tds = $(row).find("td");
    const noteId = tds.eq(1).text().trim();
    const bg = $(row).attr("style") || "";
    notes.push({
      id: noteId,
      isYellow: bg.includes("#FFF3CD") || bg.includes("rgb(255, 243, 205)"),
    });
  });

  return notes;
}

async function checkNotes() {
  if (!globalClient) globalClient = (await login()).client;

  const notes = await fetchTableData(globalClient);
  const currentNoteCount = notes.length;
  console.log(`🧾 Fișiere detectate: ${currentNoteCount}`);

  const currentIds = notes.map((n) => n.id);
  const previousIds = previousNotes.map((n) => n.id);

  const newOnes = notes.filter((n) => !previousIds.includes(n.id));
  const disappeared = previousNotes.filter((n) => !currentIds.includes(n.id));

  if (newOnes.length > 0) {
    await sendTelegram(
      `📥 S-au adăugat ${newOnes.length} fișier(e):\n${newOnes.map((n) => n.id).join("\n")}`
    );
  }

  if (disappeared.length > 0) {
    await sendTelegram(
      `🗑️ Au dispărut ${disappeared.length} fișier(e):\n${disappeared.map((n) => n.id).join("\n")}`
    );
  }

  previousNoteCount = currentNoteCount;
  previousNotes = notes;
}

(async () => {
  try {
    console.log("🔁 Monitor activ.");
    await checkNotes();
    setInterval(async () => {
      console.log("\n⏰ Verificare periodică...");
      await checkNotes();
    }, 60_000);
  } catch (err) {
    console.error("💥 Eroare:", err.message);
  }
})();
