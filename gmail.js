#!/usr/bin/env node
// friday-gmail: a Gmail CLI for AI agents that structurally cannot send email.
// It reads, labels, and drafts. A human clicks send.
//
// Safety properties (the whole point):
//   * No send capability exists in this code. Not a flag, not a hidden command.
//     `draft` creates an UNSENT Gmail draft; nothing leaves until a human clicks
//     send in Gmail.
//   * OAuth scope is gmail.modify only, so it cannot permanently delete mail.
//   * archive/trash tag messages under a configurable label prefix as an audit
//     trail, and `restore` undoes them.
//
// Zero dependencies, Node 18+. Configuration comes from a JSON config file
// (see friday-gmail.example.json), resolved in this order:
//   --config <file>  >  $FRIDAY_GMAIL_CONFIG  >  ./friday-gmail.json
//   >  ~/.config/friday-gmail/config.json
//
// One-time auth (two-step, the browser can be on any device):
//   auth-url [account]            print consent URL (PKCE verifier saved to state)
//   auth-exchange <redirect-url>  exchange the pasted redirect URL/code for a
//                                 refresh token; prints which mailbox it belongs to
// Commands ([account] is optional when the config defines exactly one account):
//   accounts                      list account keys and which have tokens
//   count                         inbox message/thread/unread counts per account
//   inbox [account] [--max N]     inbox messages as JSON lines (metadata + snippet)
//   search [account] <q> [--max N]  all-mail search (Gmail query syntax) as JSON lines
//   get [account] <msgId>         full message: headers, text body, attachments
//   attachment [account] <msgId> <attachmentId> <outPath>
//   draft [account] <emailFile> [--sig <htmlFile>] [--reply <msgId>] [attachmentPath...]
//                                 create an UNSENT draft; --reply <msgId> threads it
//                                 into that message's conversation. The emailFile has
//                                 To:/An: + Subject:/Betreff: (optional Cc:/Kopie:)
//                                 header lines, a blank line, then the body. Drafts are ALWAYS built as
//                                 multipart/alternative (text + HTML, newlines to
//                                 <br>) so paragraph breaks survive editing in HTML
//                                 mail clients. --sig appends an optional HTML signature.
//   drafts [account] [--max N]    list unsent drafts (draft id, thread, to, subject)
//   draft-discard [account] <draftId>  delete an UNSENT draft (sent mail is never
//                                 deletable here; this only affects drafts)
//   archive [account] <msgId...>  remove INBOX, add <prefix>/archived
//   trash [account] <msgId...>    add <prefix>/trashed, move to Trash
//   restore [account] <msgId...>  undo: untrash + re-add INBOX, strip <prefix>/*
//   label [account] <name> <msgId...>  add a label (created if missing)
//
// Env:
//   GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, plus one refresh-token
//   variable per account as named by "tokenEnv" in the config.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

function die(msg) {
  console.error(`friday-gmail: ${msg}`);
  process.exit(1);
}

// ---------- config ----------

function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function loadConfig(argv) {
  // --config <file> may appear anywhere; consume it before command dispatch.
  let path = null;
  const i = argv.indexOf("--config");
  if (i >= 0) {
    path = argv[i + 1];
    if (!path) die("--config needs a file path");
    argv.splice(i, 2);
  }
  path ??= process.env.FRIDAY_GMAIL_CONFIG ?? null;
  if (!path) {
    for (const cand of [resolve("friday-gmail.json"), join(homedir(), ".config", "friday-gmail", "config.json")]) {
      if (existsSync(cand)) {
        path = cand;
        break;
      }
    }
  }
  if (!path)
    die(
      "no config found. Pass --config <file>, set FRIDAY_GMAIL_CONFIG, or create ./friday-gmail.json or ~/.config/friday-gmail/config.json (see friday-gmail.example.json)"
    );
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(expandHome(path), "utf8"));
  } catch (e) {
    die(`cannot read config ${path}: ${e.message}`);
  }
  if (!cfg.accounts || typeof cfg.accounts !== "object" || !Object.keys(cfg.accounts).length)
    die(`config ${path} defines no accounts`);
  for (const [k, a] of Object.entries(cfg.accounts)) {
    if (!a.email || !a.tokenEnv) die(`config ${path}: account "${k}" needs both "email" and "tokenEnv"`);
  }
  cfg.labelPrefix ??= "friday";
  cfg.stateDir = expandHome(cfg.stateDir ?? "~/.config/friday-gmail");
  cfg.redirectPort ??= 8479;
  return cfg;
}

const argv = process.argv.slice(2);
const CONFIG = loadConfig(argv);
const ACCOUNTS = CONFIG.accounts;
const LABEL_PREFIX = CONFIG.labelPrefix;
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const REDIRECT_URI = `http://127.0.0.1:${CONFIG.redirectPort}`;
const STATE_DIR = CONFIG.stateDir;
const STATE_FILE = join(STATE_DIR, "state.json");
const CLIENT_ID = process.env.GMAIL_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_OAUTH_CLIENT_SECRET;

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function account(key) {
  const a = ACCOUNTS[key];
  if (!a) die(`unknown account "${key}" (known: ${Object.keys(ACCOUNTS).join(", ")})`);
  return a;
}

// Pull the account key off the front of the args. With exactly one configured
// account the key may be omitted entirely.
function takeAccount(args, usage) {
  if (args[0] && ACCOUNTS[args[0]]) return [args[0], args.slice(1)];
  const keys = Object.keys(ACCOUNTS);
  if (keys.length === 1) return [keys[0], args];
  return [die(`first argument must be an account (${keys.join(", ")}). Usage: ${usage}`), []];
}

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeB64url(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function rfc2047(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

// Split an address list on top-level commas, honoring quoted display names and
// <addr-spec> so a comma inside "Doe, John" <..> doesn't split the address.
function splitAddresses(list) {
  const out = [];
  let cur = "", inQuote = false, inAngle = false;
  for (const ch of list) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    else if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    if (ch === "," && !inQuote && !inAngle) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// Encode the display-name part of each address as RFC 2047, leaving the
// addr-spec untouched. A non-ASCII display name written raw into a To/Cc header
// renders as mojibake (e.g. "Jeglič" -> "JegliÄ"). Pure-ASCII names keep their
// existing form, including any RFC 5322 quoting.
function encodeAddressList(list) {
  return splitAddresses(list)
    .map((a) => a.trim())
    .filter(Boolean)
    .map((addr) => {
      const m = addr.match(/^(.*?)\s*<([^>]*)>$/);
      if (!m) return addr; // bare addr-spec, already ASCII
      const rawName = m[1].trim();
      const email = m[2].trim();
      if (!rawName) return `<${email}>`;
      if (/^[\x20-\x7e]*$/.test(rawName)) return `${rawName} <${email}>`;
      // An encoded-word must not sit inside a quoted-string, so strip any
      // surrounding quotes before encoding.
      return `${rfc2047(rawName.replace(/^"(.*)"$/, "$1"))} <${email}>`;
    })
    .join(", ");
}

// ---------- OAuth ----------

async function tokenPost(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) die(`token endpoint: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const accessTokens = {};
async function accessToken(key) {
  if (accessTokens[key]) return accessTokens[key];
  const refresh = process.env[account(key).tokenEnv];
  if (!refresh) die(`${account(key).tokenEnv} not set. Run auth-url/auth-exchange for "${key}" first`);
  const body = await tokenPost({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  accessTokens[key] = body.access_token;
  return body.access_token;
}

function cmdAuthUrl(key) {
  const a = account(key);
  const verifier = b64url(randomBytes(32));
  const state = readState();
  state.pkce_verifier = verifier;
  writeState(state);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    login_hint: a.email,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  console.log(`Open this URL in a browser and sign in as ${a.email}:\n\n${url}\n`);
  console.log(
    `After consenting you'll land on a dead ${REDIRECT_URI}/?code=... page.\nCopy that full URL from the address bar and run: friday-gmail auth-exchange '<url>'`
  );
}

async function cmdAuthExchange(pasted) {
  if (!pasted) die("pass the redirect URL (or bare code)");
  let code = pasted;
  if (pasted.includes("code=")) code = new URL(pasted).searchParams.get("code");
  const verifier = readState().pkce_verifier;
  if (!verifier) die("no PKCE verifier in state. Run auth-url first");
  const body = await tokenPost({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });
  if (!body.refresh_token) die(`no refresh_token in response: ${JSON.stringify(body)}`);
  // Confirm which mailbox this token actually belongs to before storing it.
  const prof = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${body.access_token}` },
    signal: AbortSignal.timeout(30_000),
  }).then((r) => r.json());
  const match = Object.entries(ACCOUNTS).find(([, a]) => a.email === prof.emailAddress);
  console.log(JSON.stringify({ email: prof.emailAddress, account: match?.[0] ?? null, token_env: match?.[1].tokenEnv ?? null, refresh_token: body.refresh_token }));
}

// ---------- Gmail API ----------

async function api(key, path, opts = {}) {
  const token = await accessToken(key);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) die(`${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function header(msg, name) {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

const labelCache = {};
async function labelId(key, name) {
  if (!labelCache[key]) {
    const { labels } = await api(key, "labels");
    labelCache[key] = Object.fromEntries(labels.map((l) => [l.name, l.id]));
  }
  if (!labelCache[key][name]) {
    const created = await api(key, "labels", {
      method: "POST",
      body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
    });
    labelCache[key][name] = created.id;
  }
  return labelCache[key][name];
}

async function modify(key, msgId, addNames, removeIds) {
  const addLabelIds = [];
  for (const n of addNames) addLabelIds.push(await labelId(key, n));
  await api(key, `messages/${msgId}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds, removeLabelIds: removeIds }),
  });
}

async function cmdInbox(key, args) {
  const maxIdx = args.indexOf("--max");
  const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 50;
  let pageToken;
  let fetched = 0;
  do {
    const q = new URLSearchParams({ labelIds: "INBOX", maxResults: String(Math.min(max - fetched, 100)) });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await api(key, `messages?${q}`);
    for (const { id } of page.messages ?? []) {
      const m = await api(key, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=Message-ID`);
      // Deep link that opens the right account and exact message in Gmail web/app.
      const mid = header(m, "Message-ID").replace(/^<|>$/g, "");
      console.log(
        JSON.stringify({
          id: m.id,
          threadId: m.threadId,
          from: header(m, "From"),
          to: header(m, "To"),
          subject: header(m, "Subject"),
          date: header(m, "Date"),
          list_unsubscribe: header(m, "List-Unsubscribe") ? true : false,
          labels: m.labelIds ?? [],
          snippet: m.snippet ?? "",
          link: mid ? `https://mail.google.com/mail/?authuser=${account(key).email}#search/rfc822msgid:${encodeURIComponent(mid)}` : `https://mail.google.com/mail/?authuser=${account(key).email}#all/${m.id}`,
        })
      );
      fetched++;
    }
    pageToken = page.nextPageToken;
  } while (pageToken && fetched < max);
}

async function cmdSearch(key, args) {
  const q = args[0];
  if (!q || q.startsWith("--")) die("usage: search [account] <gmail-query> [--max N]");
  const maxIdx = args.indexOf("--max");
  const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 25;
  let pageToken;
  let fetched = 0;
  do {
    const params = new URLSearchParams({ q, maxResults: String(Math.min(max - fetched, 100)) });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await api(key, `messages?${params}`);
    for (const { id } of page.messages ?? []) {
      const m = await api(key, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`);
      const mid = header(m, "Message-ID").replace(/^<|>$/g, "");
      console.log(
        JSON.stringify({
          id: m.id,
          threadId: m.threadId,
          from: header(m, "From"),
          to: header(m, "To"),
          subject: header(m, "Subject"),
          date: header(m, "Date"),
          labels: m.labelIds ?? [],
          snippet: m.snippet ?? "",
          link: mid ? `https://mail.google.com/mail/?authuser=${account(key).email}#search/rfc822msgid:${encodeURIComponent(mid)}` : `https://mail.google.com/mail/?authuser=${account(key).email}#all/${m.id}`,
        })
      );
      fetched++;
    }
    pageToken = page.nextPageToken;
  } while (pageToken && fetched < max);
}

function walkParts(payload, out) {
  if (!payload) return;
  const { mimeType, body, parts, filename } = payload;
  if (filename && body?.attachmentId) {
    out.attachments.push({ filename, mimeType, size: body.size, attachmentId: body.attachmentId });
  } else if (mimeType === "text/plain" && body?.data) {
    out.text += decodeB64url(body.data).toString("utf8");
  } else if (mimeType === "text/html" && body?.data) {
    out.html += decodeB64url(body.data).toString("utf8");
  }
  for (const p of parts ?? []) walkParts(p, out);
}

async function cmdGet(key, msgId) {
  const m = await api(key, `messages/${msgId}?format=full`);
  const out = { text: "", html: "", attachments: [] };
  walkParts(m.payload, out);
  // Prefer plain text; fall back to crudely de-tagged HTML.
  const body = out.text || out.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  console.log(
    JSON.stringify({
      id: m.id,
      threadId: m.threadId,
      from: header(m, "From"),
      to: header(m, "To"),
      subject: header(m, "Subject"),
      date: header(m, "Date"),
      labels: m.labelIds ?? [],
      body: body.slice(0, 20_000),
      attachments: out.attachments,
    })
  );
}

async function cmdAttachment(key, msgId, attachmentId, outPath) {
  if (!outPath) die("usage: attachment [account] <msgId> <attachmentId> <outPath>");
  const att = await api(key, `messages/${msgId}/attachments/${attachmentId}`);
  writeFileSync(outPath, decodeB64url(att.data));
  console.log(JSON.stringify({ written: outPath, bytes: att.size }));
}

async function cmdDraft(key, args) {
  const emailFile = args[0];
  if (!emailFile || emailFile.startsWith("--")) die("usage: draft [account] <emailFile> [--sig <htmlFile>] [--reply <msgId>] [attachmentPath...]");
  // Parse the rest: --sig <file> selects an HTML signature; --reply <msgId> threads
  // the draft into that message's conversation; everything else is an attachment path.
  let sigFile = null;
  let replyMsgId = null;
  const attachments = [];
  const rest = args.slice(1);
  for (let j = 0; j < rest.length; j++) {
    if (rest[j] === "--sig") sigFile = rest[++j];
    else if (rest[j] === "--reply") replyMsgId = rest[++j];
    else attachments.push(rest[j]);
  }

  const src = readFileSync(emailFile, "utf8");
  const lines = src.split(/\r?\n/);
  let to = "", cc = "", subject = "", i = 0;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "") { i++; break; }
    const m = lines[i].match(/^(To|An|Cc|Kopie|Subject|Betreff):\s*(.*)$/i);
    if (!m) break;
    const k = m[1].toLowerCase();
    if (k === "to" || k === "an") to = m[2].trim();
    else if (k === "cc" || k === "kopie") cc = m[2].trim();
    else if (k === "subject" || k === "betreff") subject = m[2].trim();
  }
  if (!to) die("no To:/An: header found in email file");
  const body = lines.slice(i).join("\n");

  const CRLF = "\r\n";
  // When replying, pull the target message's threadId + Message-ID/References so Gmail
  // stitches the draft into the existing conversation instead of starting a new one.
  let threadId = null;
  let replyHeaders = "";
  if (replyMsgId) {
    const rm = await api(key, `messages/${replyMsgId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`);
    threadId = rm.threadId;
    const mid = header(rm, "Message-ID");
    const refs = header(rm, "References");
    if (mid) {
      replyHeaders =
        `In-Reply-To: ${mid}${CRLF}` +
        `References: ${(refs ? refs + " " : "") + mid}${CRLF}`;
    }
  }
  const encSubject = /[^\x00-\x7F]/.test(subject)
    ? `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`
    : subject;
  const wrap = (b64) => b64.replace(/(.{76})/g, `$1${CRLF}`);
  const b64buf = (s) => Buffer.from(s, "utf8").toString("base64");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const mkBoundary = (p) => `==${p}_${b64url(randomBytes(9))}==`;

  // Build the body section: ALWAYS a multipart/alternative carrying a text/plain
  // fallback plus a text/html version, with \n -> <br> so paragraph breaks survive
  // when the draft is opened in an HTML mail editor. (A plain-text-only draft has
  // its bare newlines collapsed into one run-on block by some editors, so we
  // never emit that form.) --sig, if given, appends an optional HTML signature.
  const sig = sigFile ? readFileSync(sigFile, "utf8") : "";
  const htmlDoc =
    `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333333;line-height:1.5;">` +
    esc(body).replace(/\r?\n/g, "<br>\n") + (sig ? `<br><br>${sig}` : "") + `</body></html>`;
  const altB = mkBoundary("alt");
  const altBytes = Buffer.from(
    `--${altB}${CRLF}Content-Type: text/plain; charset="UTF-8"${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}` + wrap(b64buf(body)) + CRLF +
    `--${altB}${CRLF}Content-Type: text/html; charset="UTF-8"${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}` + wrap(b64buf(htmlDoc)) + CRLF +
    `--${altB}--${CRLF}`, "utf8");
  const bodySection = { ct: `multipart/alternative; boundary="${altB}"`, bytes: altBytes, multipart: true };

  // Assemble: wrap in multipart/mixed when there are attachments, else send the body section directly.
  let headers, payload;
  if (attachments.length) {
    const mixB = mkBoundary("mix");
    const chunks = [];
    let bodyHdr = `--${mixB}${CRLF}Content-Type: ${bodySection.ct}${CRLF}`;
    if (!bodySection.multipart) bodyHdr += `Content-Transfer-Encoding: ${bodySection.cte}${CRLF}`;
    chunks.push(Buffer.from(bodyHdr + CRLF, "utf8"), bodySection.bytes);
    for (const p of attachments) {
      const data = readFileSync(p);
      const fname = p.split("/").pop();
      chunks.push(Buffer.from(
        `--${mixB}${CRLF}Content-Type: application/octet-stream; name="${fname}"${CRLF}` +
        `Content-Transfer-Encoding: base64${CRLF}Content-Disposition: attachment; filename="${fname}"${CRLF}${CRLF}` +
        wrap(data.toString("base64")) + CRLF, "utf8"));
    }
    chunks.push(Buffer.from(`--${mixB}--${CRLF}`, "utf8"));
    headers = `Content-Type: multipart/mixed; boundary="${mixB}"${CRLF}`;
    payload = Buffer.concat(chunks);
  } else {
    headers = `Content-Type: ${bodySection.ct}${CRLF}`;
    if (!bodySection.multipart) headers += `Content-Transfer-Encoding: ${bodySection.cte}${CRLF}`;
    payload = bodySection.bytes;
  }

  const top = Buffer.concat([
    Buffer.from(`To: ${encodeAddressList(to)}${CRLF}${cc ? `Cc: ${encodeAddressList(cc)}${CRLF}` : ""}From: ${account(key).email}${CRLF}Subject: ${encSubject}${CRLF}MIME-Version: 1.0${CRLF}${replyHeaders}${headers}${CRLF}`, "utf8"),
    payload,
  ]);
  const message = { raw: b64url(top) };
  if (threadId) message.threadId = threadId;
  const res = await api(key, "drafts", { method: "POST", body: JSON.stringify({ message }) });
  console.log(JSON.stringify({
    draftId: res.id,
    to, cc: cc || undefined, subject,
    html: true,
    threadId,
    attachments: attachments.map((p) => p.split("/").pop()),
    open: `https://mail.google.com/mail/?authuser=${account(key).email}#drafts`,
  }));
}

// ---------- main ----------

if (!CLIENT_ID || !CLIENT_SECRET) die("GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET not set");
const [cmd, ...args] = argv;

if (cmd === "count") {
  for (const k of Object.keys(ACCOUNTS)) {
    const l = await api(k, "labels/INBOX");
    console.log(`${k}\t${ACCOUNTS[k].email}\tinbox messages=${l.messagesTotal} threads=${l.threadsTotal} unread=${l.messagesUnread}`);
  }
} else if (cmd === "accounts") {
  for (const [k, a] of Object.entries(ACCOUNTS)) console.log(`${k}\t${a.email}\t${process.env[a.tokenEnv] ? "token OK" : "NO TOKEN"}`);
} else if (cmd === "auth-url") {
  const [key] = takeAccount(args, "auth-url [account]");
  cmdAuthUrl(key);
} else if (cmd === "auth-exchange") await cmdAuthExchange(args[0]);
else if (cmd === "inbox") {
  const [key, rest] = takeAccount(args, "inbox [account] [--max N]");
  await cmdInbox(key, rest);
} else if (cmd === "search") {
  const [key, rest] = takeAccount(args, "search [account] <gmail-query> [--max N]");
  await cmdSearch(key, rest);
} else if (cmd === "get") {
  const [key, rest] = takeAccount(args, "get [account] <msgId>");
  await cmdGet(key, rest[0] ?? die("usage: get [account] <msgId>"));
} else if (cmd === "attachment") {
  const [key, rest] = takeAccount(args, "attachment [account] <msgId> <attachmentId> <outPath>");
  await cmdAttachment(key, rest[0], rest[1], rest[2]);
} else if (cmd === "draft") {
  const [key, rest] = takeAccount(args, "draft [account] <emailFile> [--sig <htmlFile>] [--reply <msgId>] [attachmentPath...]");
  await cmdDraft(key, rest);
} else if (cmd === "drafts") {
  // List existing drafts (id, thread, subject) so a stale draft can be found and discarded.
  const [key, rest] = takeAccount(args, "drafts [account] [--max N]");
  const maxIdx = rest.indexOf("--max");
  const max = maxIdx >= 0 ? Number(rest[maxIdx + 1]) : 20;
  const list = await api(key, `drafts?maxResults=${max}`);
  for (const d of list.drafts ?? []) {
    const m = await api(key, `messages/${d.message.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=To`);
    console.log(JSON.stringify({ draft_id: d.id, message_id: d.message.id, thread_id: d.message.threadId, to: header(m, "To"), subject: header(m, "Subject") }));
  }
} else if (cmd === "draft-discard") {
  // Discards an unsent DRAFT (drafts.delete). Messages/threads are never deletable here.
  const [key, rest] = takeAccount(args, "draft-discard [account] <draftId>");
  if (!rest[0]) die("usage: draft-discard [account] <draftId>");
  await api(key, `drafts/${rest[0]}`, { method: "DELETE" });
  console.log(JSON.stringify({ discarded: rest[0] }));
} else if (cmd === "archive") {
  const [key, ids] = takeAccount(args, "archive [account] <msgId...>");
  for (const id of ids) await modify(key, id, [`${LABEL_PREFIX}/archived`], ["INBOX"]);
  console.log(`archived ${ids.length}`);
} else if (cmd === "trash") {
  const [key, ids] = takeAccount(args, "trash [account] <msgId...>");
  for (const id of ids) {
    await modify(key, id, [`${LABEL_PREFIX}/trashed`], []);
    await api(key, `messages/${id}/trash`, { method: "POST" });
  }
  console.log(`trashed ${ids.length}`);
} else if (cmd === "restore") {
  // Undo a trash or archive: pull it back to the inbox and strip the <prefix>/*
  // action labels. untrash is a safe no-op on a message that isn't in Trash.
  const [key, ids] = takeAccount(args, "restore [account] <msgId...>");
  const trashedId = await labelId(key, `${LABEL_PREFIX}/trashed`);
  const archivedId = await labelId(key, `${LABEL_PREFIX}/archived`);
  for (const id of ids) {
    await api(key, `messages/${id}/untrash`, { method: "POST" });
    await modify(key, id, ["INBOX"], [trashedId, archivedId]);
  }
  console.log(`restored ${ids.length}`);
} else if (cmd === "label") {
  const [key, rest] = takeAccount(args, "label [account] <name> <msgId...>");
  const [name, ...ids] = rest;
  if (!name || !ids.length) die("usage: label [account] <name> <msgId...>");
  for (const id of ids) await modify(key, id, [name], []);
  console.log(`labeled ${ids.length}`);
} else {
  die("usage: accounts | count | auth-url | auth-exchange | inbox | search | get | attachment | draft | drafts | draft-discard | archive | trash | restore | label (no send, by design)");
}
