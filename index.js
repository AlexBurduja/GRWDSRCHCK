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

const MONITORED_LIQUIDATORS = [
  { id: "507", name: "Burduja Alexandru", enabled: true },
  { id: "92", name: "Agiu Ionut", enabled: true },
  { id: "88", name: "Donici Alexandru", enabled: true },
  ///{ id: "51", name: "Bucur Mihai", enabled: true },
  ///{ id: "16", name: "Balta Dan", enabled: true },
  ///{ id: "89", name: "Maianu Marian", enabled: true },
  ///{ id : "0", name: "--- Toti ---", enabled: true }, 
];

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Botul este activ.");
});

app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const body = req.body;

  // 🔥 Dacă vine un callback_query (apasă pe buton)
  if (body.callback_query) {
    const callback = body.callback_query;
    const chatId = callback.message.chat.id;
    const data = callback.data;

    if (data.startsWith("status:")) {
      const name = data.substring(7);

      // 📤 Răspundem imediat la callback_query ca să evităm blocaje
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: callback.id
      });

      // 📬 Trimitem un mesaj de încărcare
      await sendTelegram(`🔍 Am selectat: ${name}\n⏳ Se încarcă statusul...`, chatId);

      // 🧠 AICI continuăm logica fără să mai blocăm request-ul
      setTimeout(async () => {
        try {
          if (!globalClient) {
            const result = await login();
            globalClient = result.client;
          }

          const { notes, messageId } = await fetchTableDataFor(name, globalClient, chatId);

          const total = notes.length;
          const yellow = notes.filter(n => n.isYellow).length;
          const white = total - yellow;

          await sendTelegram(`📊 Status pentru ${name}:\n🟡 Galbene: ${yellow}\n✅ Albe: ${white}\n📦 Total: ${total}`, chatId);
        } catch (error) {
          await sendTelegram(`❌ Eroare: ${error.message}`, chatId);
        }
      }, 0);
    }

    return res.sendStatus(200); // 🚀 închidem rapid request-ul ca să nu mai repornească serverul!
  }

  const message = body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/test") {
    await sendTelegram("✅ Botul funcționează corect!", chatId);
  }

  if (text === "/check") {
    if (fs.existsSync(COOKIE_FILE)) {
      const cookieFile = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
      const cookies = cookieFile.cookies || [];
      const cookie2FA = cookies.find(c => c.key === "2faKey");

      if (cookie2FA && cookie2FA.expires) {
        const expiryDate = new Date(cookie2FA.expires);
        const now = new Date();
        const diffMs = expiryDate - now;
        const daysLeft = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

        const creationDate = new Date(cookie2FA.creation);

        const ziua = creationDate.getDate().toString().padStart(2, '0');
        const luna = (creationDate.getMonth() + 1).toString().padStart(2, '0');
        const anul = creationDate.getFullYear();
        const ora = creationDate.getHours().toString().padStart(2, '0');
        const minutul = creationDate.getMinutes().toString().padStart(2, '0');
        
        const formatFinal = `${ziua}.${luna}.${anul} ${ora}:${minutul}`;

        await sendTelegram(`🔐 2FA a fost creat pe ${formatFinal} și expiră în ${daysLeft} zile.`, chatId);
      } else {
        await sendTelegram("⚠️ Cookie-ul 2FA nu a fost găsit. Probabil nu ai trecut încă prin 2FA.", chatId);
      }
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

  if (text.startsWith("/status ")) {
    const name = text.substring(8).trim();
    try {
      const { notes, messageId } = await fetchTableDataFor(name, globalClient, chatId);

      const total = notes.length;
      const yellow = notes.filter(n => n.isYellow).length;
      const white = total - yellow;

      await editTelegram(messageId, `📊 Status pentru ${name}:\n🟡 Galbene: ${yellow}\n✅ Albe: ${white}\n📦 Total: ${total}`, chatId);
    } catch (error) {
      await sendTelegram(`❌ Eroare: ${error.message}`, chatId);
    }
  }

  if (text === "/status") {
    if (!globalClient) {
      const result = await login();
      globalClient = result.client;
    }

    const colegi = await fetchColegi(globalClient);

    const inlineKeyboard = colegi.map(nume => {
      return [{ text: nume, callback_data: `status:${nume}` }];
    });

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: "👥 Alege colegul pentru care vrei status:",
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  }

  res.sendStatus(200); // ⚡️ Închidem rapid și mesajele normale
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

async function editTelegram(msgId, newText, chatId = TELEGRAM_CHAT_ID) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
      chat_id: chatId,
      message_id: msgId,
      text: newText,
    });
  } catch (error) {
    console.log("Error editing Telegram message:", error.message);
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

async function saveNotesToGist(inspectorId, notes) {
  if (!GIST_ID_NOTES || !GITHUB_TOKEN) return;
  try {
    await axios.patch(
      `https://api.github.com/gists/${GIST_ID_NOTES}`,
      {
        files: {
          [`notes_${inspectorId}.json`]: {
            content: JSON.stringify(notes, null, 2),
          },
        },
      },
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
        },
      }
    );
    console.log(`💾 notes_${inspectorId}.json salvat în Gist.`);
  } catch (err) {
    console.error("❌ Eroare la salvare notes în Gist:", err.message);
  }
}

async function loadNotesFromGist(inspectorId) {
  if (!GIST_ID_NOTES || !GITHUB_TOKEN) return [];
  try {
    const res = await axios.get(`https://api.github.com/gists/${GIST_ID_NOTES}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
    });

    const file = res.data.files[`notes_${inspectorId}.json`];
    if (!file) return [];

    return JSON.parse(file.content);
  } catch (err) {
    console.error("❌ Eroare la încărcare notes:", err.message);
    return [];
  }
}

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

async function fetchTableDataFor(name, client) {
  const response = await client.get(TARGET_URL);
  const $ = cheerio.load(response.data);

  const viewstate = $("#__VIEWSTATE").val();
  const eventvalidation = $("#__EVENTVALIDATION").val();
  const viewstategenerator = $("#__VIEWSTATEGENERATOR").val();
  const dropdownName = "ctl00$ContentPlaceHolderMain$DropDownListFilterLiquidator";
  const buttonName = "ctl00$ContentPlaceHolderMain$ButtonFilter";

  const dropdownOption = $(`select[name="${dropdownName}"] option`).filter(function () {
    return $(this).text().trim().toLowerCase() === name.trim().toLowerCase();
  }).attr("value");

  if (!dropdownOption) {
    console.warn(`⚠️ Lichidatorul ${name} nu a fost găsit. Retry simplu în 2s...`);
    await new Promise(r => setTimeout(r, 2000));
  
    // Retry simplu
    const retryRes = await client.get(TARGET_URL);
    const $$retry = cheerio.load(retryRes.data);
    const retryOption = $$retry(`select[name="${dropdownName}"] option`).filter(function () {
      return $$(this).text().trim().toLowerCase() === name.trim().toLowerCase();
    }).attr("value");
  
    if (retryOption) {
      console.log(`✅ Retry reușit pentru ${name}`);
      return await fetchTableDataFor(name, client);
    }
  
    // Retry eșuat → încercăm relogin
    console.log(`🔁 Retry eșuat. Încerc relogin pentru ${name}...`);
    const { client: newClient } = await login(true);
    const reloginRes = await newClient.get(TARGET_URL);
    const $$$ = cheerio.load(reloginRes.data);
    const reloginOption = $$$(`select[name="${dropdownName}"] option`).filter(function () {
      return $$$(this).text().trim().toLowerCase() === name.trim().toLowerCase();
    }).attr("value");
  
    if (reloginOption) {
      console.log(`🔓 Relogin reușit pentru ${name}`);
      return await fetchTableDataFor(name, newClient);
    }
  
    // Dacă tot nu merge, salvăm pagina pentru debug
    const filename = `debug_dropdown_${name.replace(/ /g, "_")}_${Date.now()}.html`;
    fs.writeFileSync(filename, reloginRes.data);
    console.warn(`❌ Lichidatorul ${name} nu a fost găsit nici după retry + relogin. HTML salvat: ${filename}`);
  
    throw new Error(`❌ Nu am găsit lichidatorul ${name} nici după retry și relogin.`);
}

  const payload = {
    __VIEWSTATE: viewstate,
    __VIEWSTATEGENERATOR: viewstategenerator,
    __EVENTVALIDATION: eventvalidation,
    Hidden_ClientJS: $("#Hidden_ClientJS").val() || "",
    __EVENTTARGET: buttonName,
    __EVENTARGUMENT: "",
  };
  payload[dropdownName] = dropdownOption;

  const postResponse = await client.post(TARGET_URL, qs.stringify(payload), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: TARGET_URL,
      Origin: BASE_URL,
    },
  });

  const $$ = cheerio.load(postResponse.data);
  const table = $$("table#ctl00_ContentPlaceHolderMain_TabContainer_MAIN_TabPanel_APPROVAL_LIST_GridViewApprovalList");

  if (!table.length) {
    throw new Error(`❌ Nu am găsit tabelul după filtrare pentru ${name}.`);
  }

  const rows = table.find("tr").slice(1);
  const notes = [];

  for (const row of rows) {
    const $row = $$(row);
    const tds = $row.find("td");
    const noteId = tds.eq(1).text().trim();
    const bgcolorAttr = $row.attr("bgcolor")?.toLowerCase() || "";
    const isYellow = bgcolorAttr === "#fff3cd";

    notes.push({ id: noteId, isYellow });
  }

  return { notes };
}

async function fetchColegi(client) {
  const response = await client.get(TARGET_URL);
  const $ = cheerio.load(response.data);

  const colegi = [];
  const dropdownName = "ctl00$ContentPlaceHolderMain$DropDownListFilterLiquidator";

  $(`select[name="${dropdownName}"] option`).each((_, option) => {
    const name = $(option).text().trim();
    if (name && name.length > 0 && name !== "- Toate -") {
      colegi.push(name);
    }
  });

  return colegi;
}

async function checkNotes() {
  console.log("🧠 Pornire checkNotes()...");

  if (!globalClient) globalClient = (await login()).client;

  let finalMessage = `📋 Rezumat actualizare dosare:\n\n`;
  let changesDetected = false;

  // for (const { id, name } of MONITORED_LIQUIDATORS) {
  for (const { id, name } of MONITORED_LIQUIDATORS.filter(l => l.enabled)) {
    console.log(`🔎 Verificare pentru ${name}...`);

    const previousNotes = await loadNotesFromGist(id);

    try {
      const { notes } = await fetchTableDataFor(name, globalClient);

      const currentIds = notes.map(n => n.id);
      const previousIds = previousNotes.map(n => n.id);

      const trulyNew = notes.filter(n => !previousIds.includes(n.id));
      const disappeared = previousNotes.filter(n => !currentIds.includes(n.id));
      const turnedYellow = notes.filter(n => {
        const prev = previousNotes.find(p => p.id === n.id);
        return prev && !prev.isYellow && n.isYellow;
      });
      const becameNormal = previousNotes.filter(p => {
        const curr = notes.find(n => n.id === p.id);
        return p.isYellow && curr && !curr.isYellow;
      });

      const prevMap = new Map(previousNotes.map(n => [n.id, n]));
      const currMap = new Map(notes.map(n => [n.id, n]));

      const notesChanged =
        notes.length !== previousNotes.length ||
        [...currMap.keys()].some(id => !prevMap.has(id)) ||
        [...prevMap.keys()].some(id => !currMap.has(id)) ||
        [...currMap.keys()].some(id => {
          const prev = prevMap.get(id);
          const curr = currMap.get(id);
          return prev && curr && prev.isYellow !== curr.isYellow;
        });

      finalMessage += `📌 ${name}:\n`;

      if (notesChanged) {
        changesDetected = true;

        for (const d of disappeared) {
          finalMessage += `🗑️ dosar eliminat – ${d.id}\n`;
        }

        for (const n of trulyNew) {
          finalMessage += `📥 dosar nou – ${n.id}${n.isYellow ? " (galben)" : ""}\n`;
        }

        for (const y of turnedYellow) {
          finalMessage += `🟡 a devenit galben – ${y.id}\n`;
        }

        for (const n of becameNormal) {
          finalMessage += `✅ a redevenit normal – ${n.id}\n`;
        }

        await saveNotesToGist(id, notes);
        console.log(`📨 ${name}: schimbări detectate și salvate.`);
      } else {
        finalMessage += `nimic schimbat\n`;
        console.log(`📭 ${name}: fără modificări.`);
      }

      finalMessage += "\n";

    } catch (err) {
      changesDetected = true;
      finalMessage += `❌ Eroare la verificare: ${err.message}\n\n`;
    }
  }

  if (changesDetected) {
    await sendTelegram(finalMessage.trim());
  } else {
    console.log("📭 Nicio modificare detectată la niciun inspector. Nu trimitem mesaj.");
  }
}

(async () => {
  await sendTelegram(`🔄 Bot repornit. Se încarcă fișierele individuale...`);
  await checkNotes();
  setInterval(async () => {
    console.log("⏰ Verificare periodică...");
    await checkNotes();
  }, 5*60_000);
})();
