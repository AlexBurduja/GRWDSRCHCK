// index.js — COMPLET cu integrare Gist și funcționalitățile originale
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
const GIST_ID_NOTES = process.env.GIST_ID_NOTES
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

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
  const total = previousNotes.length;

  const galbene = previousNotes.filter(n => n.isYellow);
  const verzi = previousNotes.filter(n => !n.isYellow);

  let message = `📊 Fișiere detectate:\n\n`;

  if (verzi.length > 0) {
    message += `✅ Verzi (${verzi.length}):\n${verzi.map(n => n.id).join("\n")}\n\n`;
  }

  if (galbene.length > 0) {
    message += `🟡 Galbene (${galbene.length}):\n${galbene.map(n => n.id).join("\n")}\n\n`;
  }

  message += `📦 Total: ${total}`;
  await sendTelegram(message, chatId);
  }

  if (text === "/check") {
    if (fs.existsSync(COOKIE_FILE)) {
      const cookieFile = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"))

      // const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
      // const loginDate = new Date(meta.loginDate);
      // const now = new Date();
      // const diffMs = now - loginDate;
      // const daysPassed = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      // const daysLeft = Math.max(0, 30 - daysPassed);

      await sendTelegram(JSON.stringify(cookieFile, null, 2), chatId)
      // await sendTelegram(`📅 Cod 2FA folosit acum ${daysPassed} zile.\n⏳ Mai sunt ${daysLeft} zile până expiră.`, chatId);
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

async function saveNotesToGist(notes) {
  if (!GIST_ID_NOTES || !GITHUB_TOKEN) return;
  try {
    await axios.patch(
      `https://api.github.com/gists/${GIST_ID_NOTES}`,
      {
        files: {
          "notes.json": { content: JSON.stringify(notes, null, 2) },
        },
      },
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
        },
      }
    );
    console.log("💾 Fișierele analizate au fost salvate în notes.json din Gist.");
  } catch (err) {
    console.error("❌ Eroare la salvarea notes.json în Gist:", err.message);
  }
}

async function loadNotesFromGist() {
  if (!GIST_ID_NOTES || !GITHUB_TOKEN) return [];
  try {
    const res = await axios.get(`https://api.github.com/gists/${GIST_ID_NOTES}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
    });
    const content = res.data.files["notes.json"].content;
    return JSON.parse(content);
  } catch (err) {
    console.error("❌ Eroare la încărcarea notes.json din Gist:", err.message);
    return [];
  }
}


// LOGIN + FETCH + CHECK FUNCTIONS

async function login(force = false) {
  const jar = await loadCookies();
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
          __VIEWSTATE: $$('input#__VIEWSTATE').val(),
          __VIEWSTATEGENERATOR: $$('input#__VIEWSTATEGENERATOR').val(),
          __EVENTVALIDATION: $$('input#__EVENTVALIDATION').val(),
          __EVENTTARGET: "",
          __EVENTARGUMENT: "",
          Hidden_ClientJS: $$('input#Hidden_ClientJS').val() || "",
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
};



async function checkNotes() {
  console.log("🧠 Pornire checkNotes()...");
  if (!globalClient) globalClient = (await login()).client;

  const notes = await fetchTableData(globalClient);
  const currentNoteCount = notes.length;
  console.log(`🧾 Fișiere detectate: ${currentNoteCount}`);

  const currentIds = notes.map(n => n.id);
  const previousIds = previousNotes.map(n => n.id);

  // Fișiere NOI (complet noi)
  const trulyNew = notes.filter(n => !previousIds.includes(n.id));

  // Fișiere care AU DISPĂRUT
  const disappeared = previousNotes.filter(n => !currentIds.includes(n.id));

  // Fișiere care AU DEVENIT GALBENE (existau înainte, dar nu erau galbene)
  const turnedYellow = notes.filter(n => {
    const prev = previousNotes.find(p => p.id === n.id);
    return prev && !prev.isYellow && n.isYellow;
  });

  // Fișiere care NU MAI SUNT GALBENE (erau galbene înainte, acum nu mai sunt)
  const becameNormal = previousNotes.filter(p => {
    const curr = notes.find(n => n.id === p.id);
    return p.isYellow && curr && !curr.isYellow;
  });

  // 📨 Trimit mesaje

  if (trulyNew.length > 0) {
    const msg = `📥 S-au adăugat ${trulyNew.length} fișier(e):\n` +
                trulyNew.map((n) => n.isYellow ? `🟡 ${n.id}` : n.id).join("\n") +
                `\n\nTotal: ${currentNoteCount}`;
    await sendTelegram(msg);
  }

  if (disappeared.length > 0) {
    const msg = `🗑️ Au dispărut ${disappeared.length} fișier(e):\n` +
                disappeared.map((n) => n.isYellow ? `🟡 ${n.id}` : n.id).join("\n") +
                `\n\nTotal: ${currentNoteCount}`;
    await sendTelegram(msg);
  }

  if (turnedYellow.length > 0) {
    const msg = `🟡 ${turnedYellow.length} fișier(e) au devenit cu fundal galben:\n` +
                turnedYellow.map(n => n.id).join("\n") +
                `\n\nTotal: ${currentNoteCount}`;
    await sendTelegram(msg);
  }

  if (becameNormal.length > 0) {
    const msg = `✅ ${becameNormal.length} fișier(e) nu mai sunt galbene:\n` +
                becameNormal.map(n => n.id).join("\n") +
                `\n\nTotal: ${currentNoteCount}`;
    await sendTelegram(msg);
  }

const prevMap = new Map(previousNotes.map(n => [n.id, n]));
const currMap = new Map(notes.map(n => [n.id, n]));

const notesChanged =
  notes.length !== previousNotes.length || // file count change
  [...currMap.keys()].some(id => !prevMap.has(id)) || // new file
  [...prevMap.keys()].some(id => !currMap.has(id)) || // removed file
  [...currMap.keys()].some(id => {
    const prev = prevMap.get(id);
    const curr = currMap.get(id);
    return prev && curr && prev.isYellow !== curr.isYellow; // color changed
  });

if (notesChanged) {
  await saveNotesToGist(notes);
  console.log("📝 notes.json actualizat în Gist.");
} else {
  console.log("📭 Nicio modificare în lista de fișiere sau culori. Gist nu a fost actualizat.");
}

previousNoteCount = currentNoteCount;
previousNotes = notes;
}

// START MONITORING
(async () => {
  previousNotes = await loadNotesFromGist();
  await sendTelegram(`🔄 Bot repornit. Fișiere restaurate din Gist: ${previousNotes.length}`);
  await checkNotes();
  setInterval(async () => {
    console.log("⏰ Verificare periodică...");
    await checkNotes();
  }, 60_000);
})();
