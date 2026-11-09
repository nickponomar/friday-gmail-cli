// Runs the real CLI (gmail.js) offline against canned API responses
// (tests/fetch-mock.mjs). Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI = fileURLToPath(new URL("../gmail.js", import.meta.url));
const MOCK = pathToFileURL(fileURLToPath(new URL("./fetch-mock.mjs", import.meta.url))).href;

function run(args, routes) {
  const dir = mkdtempSync(join(tmpdir(), "friday-gmail-test-"));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({
    accounts: {
      personal: { email: "you@example.com", tokenEnv: "TEST_TOKEN_PERSONAL" },
      work: { email: "you@work.example.com", tokenEnv: "TEST_TOKEN_WORK" },
    },
    stateDir: join(dir, "state"),
  }));
  writeFileSync(join(dir, "scenario.json"), JSON.stringify({ routes }));
  writeFileSync(join(dir, "log.jsonl"), "");
  const r = spawnSync(process.execPath, ["--import", MOCK, CLI, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      FRIDAY_GMAIL_CONFIG: config,
      GMAIL_OAUTH_CLIENT_ID: "test-client",
      GMAIL_OAUTH_CLIENT_SECRET: "test-secret",
      TEST_TOKEN_PERSONAL: "test-refresh",
      TEST_TOKEN_WORK: "test-refresh",
      MOCK_SCENARIO: join(dir, "scenario.json"),
      MOCK_LOG: join(dir, "log.jsonl"),
    },
  });
  const log = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const gmail = log.filter((e) => e.url?.startsWith("/gmail/"));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, gmail, sleeps: log.filter((e) => "sleep" in e).map((e) => e.sleep) };
}

const LABELS = {
  method: "GET",
  path: "/labels$",
  responses: [{ body: { labels: [
    { id: "INBOX", name: "INBOX" },
    { id: "Label_7", name: "receipts/2026" },
    { id: "Label_9", name: "Newsletters" },
  ] } }],
};
const BATCH_OK = { method: "POST", path: "/messages/batchModify$", responses: [{ status: 204 }] };
const ids = (n, from = 0) => Array.from({ length: n }, (_, i) => `m${from + i}`);
const batchCalls = (gmail) => gmail.filter((e) => e.url.endsWith("/messages/batchModify"));
const rateLimit403 = (reason = "rateLimitExceeded") => ({
  status: 403,
  body: { error: { code: 403, message: "Quota exceeded", errors: [{ domain: "usageLimits", reason, message: "Quota exceeded" }], status: "PERMISSION_DENIED" } },
});

// ---------- unlabel ----------

test("unlabel removes the label in batches of at most 1000 ids", () => {
  const r = run(["unlabel", "personal", "receipts/2026", ...ids(2500)], [LABELS, BATCH_OK]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "unlabeled 2500");
  const batches = batchCalls(r.gmail);
  assert.deepEqual(batches.map((b) => b.body.ids.length), [1000, 1000, 500]);
  assert.deepEqual(batches.flatMap((b) => b.body.ids), ids(2500));
  for (const b of batches) {
    assert.equal(b.method, "POST");
    assert.deepEqual(b.body.removeLabelIds, ["Label_7"]);
    assert.equal(b.body.addLabelIds, undefined);
  }
});

test("unlabel with 150 ids makes one request, not one per message", () => {
  const r = run(["unlabel", "personal", "receipts/2026", ...ids(150)], [LABELS, BATCH_OK]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(batchCalls(r.gmail).length, 1);
  assert.equal(r.gmail.filter((e) => /\/messages\/[^/]+\/modify$/.test(e.url)).length, 0);
});

test("unlabel exits cleanly and creates nothing when the label does not exist", () => {
  const r = run(["unlabel", "personal", "no-such-label", "m1", "m2"], [LABELS, BATCH_OK]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'unlabeled 0: no label "no-such-label" in personal');
  assert.equal(r.stderr, "");
  assert.deepEqual(r.gmail.map((e) => `${e.method} ${e.url}`), ["GET /gmail/v1/users/me/labels"]);
});

test("unlabel matches the label name regardless of case", () => {
  const r = run(["unlabel", "personal", "newsletters", "m1"], [LABELS, BATCH_OK]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(batchCalls(r.gmail)[0].body.removeLabelIds, ["Label_9"]);
});

test("unlabel sends each id once", () => {
  const r = run(["unlabel", "personal", "receipts/2026", "m1", "m2", "m1"], [LABELS, BATCH_OK]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "unlabeled 2");
  assert.deepEqual(batchCalls(r.gmail)[0].body.ids, ["m1", "m2"]);
});

test("unlabel passes trashed message ids straight to batchModify (no untrash, no filtering)", () => {
  const r = run(["unlabel", "personal", "receipts/2026", "trashed1", "trashed2"], [LABELS, BATCH_OK]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.gmail.map((e) => `${e.method} ${e.url}`), [
    "GET /gmail/v1/users/me/labels",
    "POST /gmail/v1/users/me/messages/batchModify",
  ]);
  assert.deepEqual(batchCalls(r.gmail)[0].body.ids, ["trashed1", "trashed2"]);
});

test("unlabel without a name or ids prints usage and fails", () => {
  for (const args of [["unlabel", "personal"], ["unlabel", "personal", "receipts/2026"]]) {
    const r = run(args, [LABELS, BATCH_OK]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /usage: unlabel \[account\] <name> <msgId\.\.\.>/);
    assert.equal(r.gmail.length, 0);
  }
});

// ---------- label ----------

test("label creates a missing label, then adds it in one batch", () => {
  const r = run(["label", "personal", "brand-new", "m1", "m2"], [
    LABELS,
    { method: "POST", path: "/labels$", responses: [{ body: { id: "Label_new", name: "brand-new" } }] },
    BATCH_OK,
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "labeled 2");
  const created = r.gmail.find((e) => e.method === "POST" && e.url.endsWith("/labels"));
  assert.equal(created.body.name, "brand-new");
  assert.deepEqual(batchCalls(r.gmail).map((b) => b.body), [{ ids: ["m1", "m2"], addLabelIds: ["Label_new"] }]);
});

test("label adds an existing label in batches of at most 1000 ids, without creating it", () => {
  const r = run(["label", "personal", "receipts/2026", ...ids(2500)], [LABELS, BATCH_OK]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "labeled 2500");
  const batches = batchCalls(r.gmail);
  assert.deepEqual(batches.map((b) => b.body.ids.length), [1000, 1000, 500]);
  assert.deepEqual(batches.flatMap((b) => b.body.ids), ids(2500));
  for (const b of batches) {
    assert.deepEqual(b.body.addLabelIds, ["Label_7"]);
    assert.equal(b.body.removeLabelIds, undefined);
  }
  assert.equal(r.gmail.filter((e) => e.method === "POST" && e.url.endsWith("/labels")).length, 0);
  assert.equal(r.gmail.filter((e) => /\/messages\/[^/]+\/modify$/.test(e.url)).length, 0);
});

test("label reuses an existing label whose name differs only in case", () => {
  const r = run(["label", "personal", "newsletters", "m1", "m1"], [LABELS, BATCH_OK]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "labeled 1");
  assert.equal(r.gmail.filter((e) => e.method === "POST" && e.url.endsWith("/labels")).length, 0);
  assert.deepEqual(batchCalls(r.gmail)[0].body, { ids: ["m1"], addLabelIds: ["Label_9"] });
});

test("label without a name or ids prints usage and fails", () => {
  const r = run(["label", "personal", "receipts/2026"], [LABELS, BATCH_OK]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: label \[account\] <name> <msgId\.\.\.>/);
  assert.equal(r.gmail.length, 0);
});

// ---------- rate-limit retry ----------

const LIST_ONE = { method: "GET", path: "/messages$", responses: [{ body: { messages: [{ id: "m1" }] } }] };
const MSG_OK = { body: { id: "m1", threadId: "t1", labelIds: ["INBOX"], snippet: "hi", payload: { headers: [{ name: "Subject", value: "Hello" }, { name: "From", value: "a@example.com" }] } } };

test("search retries a 403 rateLimitExceeded with growing backoff, then succeeds", () => {
  const r = run(["search", "personal", "newer_than:1d"], [
    LIST_ONE,
    { method: "GET", path: "/messages/m1$", responses: [rateLimit403(), rateLimit403(), MSG_OK] },
  ]);
  assert.equal(r.code, 0, r.stderr);
  const line = JSON.parse(r.stdout.trim());
  assert.equal(line.id, "m1");
  assert.equal(line.subject, "Hello");
  assert.equal(r.gmail.filter((e) => e.url.startsWith("/gmail/v1/users/me/messages/m1")).length, 3);
  assert.equal(r.sleeps.length, 2);
  assert.ok(r.sleeps[0] >= 1000 && r.sleeps[0] < 1500, `first wait ${r.sleeps[0]}`);
  assert.ok(r.sleeps[1] >= 2000 && r.sleeps[1] < 2500, `second wait ${r.sleeps[1]}`);
  assert.match(r.stderr, /rate limited \(rateLimitExceeded\) on messages\/m1, retry 1\/7/);
  assert.match(r.stderr, /retry 2\/7/);
});

test("userRateLimitExceeded and 429 are retried too", () => {
  for (const limited of [rateLimit403("userRateLimitExceeded"), { status: 429, body: { error: { code: 429, message: "Too many concurrent requests for user" } } }]) {
    const r = run(["search", "personal", "x"], [LIST_ONE, { method: "GET", path: "/messages/m1$", responses: [limited, MSG_OK] }]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.sleeps.length, 1);
  }
});

test("a Retry-After header longer than the backoff is honored", () => {
  const r = run(["search", "personal", "x"], [
    LIST_ONE,
    { method: "GET", path: "/messages/m1$", responses: [{ ...rateLimit403(), headers: { "retry-after": "30" } }, MSG_OK] },
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.sleeps[0] >= 30000 && r.sleeps[0] < 30500, `wait ${r.sleeps[0]}`);
});

test("a rate-limited batchModify is retried with the same body", () => {
  const r = run(["unlabel", "personal", "receipts/2026", ...ids(3)], [
    LABELS,
    { method: "POST", path: "/messages/batchModify$", responses: [rateLimit403(), { status: 204 }] },
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "unlabeled 3");
  const batches = batchCalls(r.gmail);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].body, batches[1].body);
});

test("gives up after 7 retries (about two minutes) and fails with the API error", () => {
  const r = run(["search", "personal", "x"], [LIST_ONE, { method: "GET", path: "/messages/m1$", responses: [rateLimit403()] }]);
  assert.equal(r.code, 1);
  assert.equal(r.sleeps.length, 7);
  assert.equal(r.gmail.filter((e) => e.url.startsWith("/gmail/v1/users/me/messages/m1")).length, 8);
  const total = r.sleeps.reduce((a, b) => a + b, 0);
  assert.ok(total >= 123000 && total < 127000, `total wait ${total}`);
  assert.match(r.stderr, /friday-gmail: messages\/m1\?[^\n]*: 403 .*rateLimitExceeded/);
});

test("other errors are not retried", () => {
  const forbidden = { status: 403, body: { error: { code: 403, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } } };
  const daily = { status: 403, body: { error: { code: 403, message: "Daily limit", errors: [{ reason: "dailyLimitExceeded" }] } } };
  for (const resp of [forbidden, daily, { status: 404, body: { error: { code: 404, message: "Not Found" } } }, { status: 500, body: "oops" }]) {
    const r = run(["search", "personal", "x"], [LIST_ONE, { method: "GET", path: "/messages/m1$", responses: [resp, MSG_OK] }]);
    assert.equal(r.code, 1, `status ${resp.status} should fail`);
    assert.equal(r.sleeps.length, 0);
  }
});

// ---------- thread and get ----------

const b64 = (s) => Buffer.from(s).toString("base64url");
const hdrs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
// A format=full message: text + HTML alternative, plus optional attachment parts.
function fullMessage(id, { internalDate, labels = ["INBOX"], from = "alex@example.com", subject = "Plans", text = `body of ${id}`, parts = [] }) {
  return {
    id, threadId: "t1", labelIds: labels, internalDate: String(internalDate),
    payload: {
      mimeType: "multipart/mixed",
      headers: hdrs({ From: from, To: "you@example.com", Cc: "sam@example.com", Subject: subject, Date: `date of ${id}` }),
      parts: [
        { mimeType: "multipart/alternative", parts: [
          { mimeType: "text/plain", body: { data: b64(text) } },
          { mimeType: "text/html", body: { data: b64(`<p>${text}</p>`) } },
        ] },
        ...parts,
      ],
    },
  };
}
const LOGO = {
  mimeType: "image/png", filename: "logo.png", body: { attachmentId: "att-logo", size: 1200 },
  headers: hdrs({ "Content-Type": "image/png", "Content-ID": "<logo@example.com>", "Content-Disposition": 'inline; filename="logo.png"' }),
};
const PDF = {
  mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "att-pdf", size: 54321 },
  headers: hdrs({ "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="invoice.pdf"' }),
};
// No Content-Disposition at all, but referenced by Content-Id (lower-case "d").
const CID_ONLY = {
  mimeType: "image/jpeg", filename: "photo.jpg", body: { attachmentId: "att-photo", size: 900 },
  headers: hdrs({ "Content-Type": "image/jpeg", "Content-Id": "<ii_photo1>" }),
};
// How Gmail sends an ordinary attachment: a Content-ID, but disposition attachment.
const GMAIL_PDF = {
  mimeType: "application/pdf", filename: "contract.pdf", body: { attachmentId: "att-contract", size: 7000 },
  headers: hdrs({ "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="contract.pdf"', "Content-ID": "<f_abc123>", "X-Attachment-Id": "f_abc123" }),
};
// Inline disposition without a Content-ID.
const INLINE_NO_CID = {
  mimeType: "image/gif", filename: "smile.gif", body: { attachmentId: "att-gif", size: 50 },
  headers: hdrs({ "Content-Type": "image/gif", "Content-Disposition": "INLINE" }),
};

// The API order is deliberately scrambled; internalDate decides.
const THREAD_MESSAGES = [
  fullMessage("m2", { internalDate: 2000, from: "you@example.com", subject: "Re: Plans" }),
  fullMessage("m4", { internalDate: 4000, labels: ["SPAM"], from: "spam@example.com" }),
  fullMessage("m1", { internalDate: 1000, parts: [PDF, LOGO] }),
  fullMessage("m3", { internalDate: 3000, labels: ["TRASH", "Label_7"], subject: "Re: Plans" }),
  fullMessage("m5", { internalDate: 5000, labels: ["INBOX", "UNREAD"], subject: "Re: Plans" }),
];
const threadRoute = (messages = THREAD_MESSAGES) => ({ method: "GET", path: "/threads/t1$", responses: [{ body: { id: "t1", messages } }] });
const parsed = (r) => r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("thread prints one line per message, oldest first, leaving out Trash and Spam", () => {
  const r = run(["thread", "personal", "t1"], [threadRoute()]);
  assert.equal(r.code, 0, r.stderr);
  const lines = parsed(r);
  assert.deepEqual(lines.map((m) => m.id), ["m1", "m2", "m5"]);
  assert.deepEqual(r.gmail.map((e) => e.url), ["/gmail/v1/users/me/threads/t1?format=full"]);
});

test("thread --all includes Trash and Spam, still oldest first", () => {
  const r = run(["thread", "personal", "t1", "--all"], [threadRoute()]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(parsed(r).map((m) => m.id), ["m1", "m2", "m3", "m4", "m5"]);
});

test("thread lines have exactly the shape get prints", () => {
  const routes = [threadRoute(), { method: "GET", path: "/messages/m1$", responses: [{ body: THREAD_MESSAGES[2] }] }];
  const t = run(["thread", "personal", "t1"], routes);
  const g = run(["get", "personal", "m1"], routes);
  assert.equal(t.code, 0, t.stderr);
  assert.equal(g.code, 0, g.stderr);
  const first = parsed(t)[0];
  assert.deepEqual(first, parsed(g)[0]);
  assert.deepEqual(Object.keys(first), ["id", "threadId", "from", "to", "cc", "reply_to", "subject", "date", "labels", "body", "attachments"]);
  assert.equal(first.from, "alex@example.com");
  assert.equal(first.cc, "sam@example.com");
  assert.equal(first.body, "body of m1");
  assert.deepEqual(parsed(t)[2].labels, ["INBOX", "UNREAD"]);
});

test("thread --html adds the html field to every message, like get --html", () => {
  const routes = [threadRoute(), { method: "GET", path: "/messages/m1$", responses: [{ body: THREAD_MESSAGES[2] }] }];
  const t = run(["thread", "personal", "--html", "t1"], routes);
  assert.equal(t.code, 0, t.stderr);
  const lines = parsed(t);
  assert.deepEqual(lines.map((m) => m.html), ["<p>body of m1</p>", "<p>body of m2</p>", "<p>body of m5</p>"]);
  assert.deepEqual(lines[0], parsed(run(["get", "personal", "m1", "--html"], routes))[0]);
  assert.ok(parsed(run(["thread", "personal", "t1"], routes)).every((m) => !("html" in m)));
});

test("thread caps body and html like get", () => {
  const big = fullMessage("m9", { internalDate: 1, text: "x".repeat(150_000) });
  const r = run(["thread", "personal", "t1", "--html"], [threadRoute([big])]);
  assert.equal(r.code, 0, r.stderr);
  const [m] = parsed(r);
  assert.equal(m.body.length, 20_000);
  assert.equal(m.html.length, 100_000);
});

test("thread makes no modifying API calls: one GET, no UNREAD removal", () => {
  const r = run(["thread", "personal", "t1", "--all", "--html"], [threadRoute(), LABELS, BATCH_OK]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.gmail.length > 0);
  for (const e of r.gmail) {
    assert.equal(e.method, "GET", e.url);
    assert.equal(e.body, null);
    assert.doesNotMatch(e.url, /modify|trash|untrash|labels/);
  }
});

test("thread whose messages are all in Trash prints nothing, says why, and exits 0", () => {
  const msgs = [fullMessage("m3", { internalDate: 3000, labels: ["TRASH"] })];
  const r = run(["thread", "personal", "t1"], [threadRoute(msgs)]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /all 1 messages of thread t1 are in Trash or Spam; pass --all/);
});

test("an unknown thread exits non-zero with a clear message", () => {
  const notFound = { status: 404, body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } } };
  const r = run(["thread", "work", "t404"], [{ method: "GET", path: "/threads/t404$", responses: [notFound] }]);
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /thread t404: not found in work \(you@work\.example\.com\) \(404\)/);
  const bad = { status: 400, body: { error: { code: 400, message: "Invalid id value", status: "INVALID_ARGUMENT" } } };
  const r2 = run(["thread", "personal", "nope"], [{ method: "GET", path: "/threads/nope$", responses: [bad] }]);
  assert.notEqual(r2.code, 0);
  assert.match(r2.stderr, /thread nope: not found in personal .*\(400\)/);
});

test("thread retries a rate limit like search and get", () => {
  const r = run(["thread", "personal", "t1"], [{ method: "GET", path: "/threads/t1$", responses: [rateLimit403(), rateLimit403(), { body: { id: "t1", messages: THREAD_MESSAGES } }] }]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.gmail.length, 3);
  assert.equal(r.sleeps.length, 2);
  assert.match(r.stderr, /rate limited \(rateLimitExceeded\) on threads\/t1, retry 1\/7/);
  assert.deepEqual(parsed(r).map((m) => m.id), ["m1", "m2", "m5"]);
});

test("thread without exactly one id prints usage and fails", () => {
  for (const args of [["thread", "personal"], ["thread", "personal", "t1", "t2"]]) {
    const r = run(args, []);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /usage: thread \[account\] <threadId> \[--html\] \[--all\]/);
    assert.equal(r.gmail.length, 0);
  }
});

test("attachments carry contentId and inline, so a signature logo is told from a file", () => {
  const m = fullMessage("m7", { internalDate: 1, parts: [PDF, LOGO, CID_ONLY, INLINE_NO_CID, GMAIL_PDF] });
  const routes = [threadRoute([m]), { method: "GET", path: "/messages/m7$", responses: [{ body: m }] }];
  const expected = [
    { filename: "invoice.pdf", mimeType: "application/pdf", size: 54321, attachmentId: "att-pdf", contentId: "", inline: false },
    { filename: "logo.png", mimeType: "image/png", size: 1200, attachmentId: "att-logo", contentId: "logo@example.com", inline: true },
    { filename: "photo.jpg", mimeType: "image/jpeg", size: 900, attachmentId: "att-photo", contentId: "ii_photo1", inline: true },
    { filename: "smile.gif", mimeType: "image/gif", size: 50, attachmentId: "att-gif", contentId: "", inline: true },
    { filename: "contract.pdf", mimeType: "application/pdf", size: 7000, attachmentId: "att-contract", contentId: "f_abc123", inline: false },
  ];
  for (const args of [["get", "personal", "m7"], ["thread", "personal", "t1"]]) {
    const r = run(args, routes);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(parsed(r)[0].attachments, expected);
  }
});

// ---------- search --ids and meta ----------

const listPage = (from, n, next) => ({ body: { messages: ids(n, from).map((id) => ({ id, threadId: `t-${id}` })), ...(next ? { nextPageToken: next } : {}) } });
const metaMessage = (id, extra = {}) => ({
  id, threadId: `t-${id}`, labelIds: ["INBOX", "UNREAD"], snippet: `snippet of ${id}`,
  payload: { headers: hdrs({ From: "Alex <alex@example.com>", To: "you@example.com", Cc: "sam@example.com", "Reply-To": "help@example.com", Subject: `Subject ${id}`, Date: `date of ${id}`, "Message-ID": `<${id}@mail.example.com>`, ...extra }) },
});
const metaRoute = (id, body) => ({ method: "GET", path: `/messages/${id}$`, responses: [{ body }] });
const listCalls = (gmail) => gmail.filter((e) => /\/messages\?/.test(e.url)).map((e) => new URL(e.url, "http://x").searchParams);
const perMessage = (gmail) => gmail.filter((e) => /\/messages\/[^/?]+\?/.test(e.url) || /\/messages\/[^/?]+$/.test(e.url));

test("search --ids prints id and threadId from the list pages, 500 per page, no per-message calls", () => {
  const list = { method: "GET", path: "/messages$", responses: [listPage(0, 500, "p2"), listPage(500, 500, "p3"), listPage(1000, 200)] };
  const r = run(["search", "personal", "newer_than:30d", "--max", "5000", "--ids"], [list]);
  assert.equal(r.code, 0, r.stderr);
  const lines = parsed(r);
  assert.equal(lines.length, 1200);
  assert.deepEqual(lines[0], { id: "m0", threadId: "t-m0" });
  assert.deepEqual(lines.map((l) => l.id), ids(1200));
  const calls = listCalls(r.gmail);
  assert.deepEqual(calls.map((p) => p.get("maxResults")), ["500", "500", "500"]);
  assert.deepEqual(calls.map((p) => p.get("pageToken")), [null, "p2", "p3"]);
  assert.ok(calls.every((p) => p.get("q") === "newer_than:30d"));
  assert.equal(perMessage(r.gmail).length, 0);
  assert.equal(r.gmail.length, 3);
});

test("search --ids stops at --max, asking only for what is left", () => {
  const list = { method: "GET", path: "/messages$", responses: [listPage(0, 500, "p2"), listPage(500, 200, "p3")] };
  // The query comes first; a flag in its place is a usage error, not a search for "--ids".
  const r = run(["search", "personal", "--ids", "in:inbox"], [list]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage: search .*\[--ids\]/);
  assert.equal(r.gmail.length, 0);
  const r2 = run(["search", "personal", "in:inbox", "--ids", "--max", "700"], [list]);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(parsed(r2).length, 700);
  assert.deepEqual(listCalls(r2.gmail).map((p) => p.get("maxResults")), ["500", "200"]);
});

test("search without --ids is unchanged: pages of 100, one metadata call per message", () => {
  const list = { method: "GET", path: "/messages$", responses: [listPage(0, 2)] };
  const r = run(["search", "personal", "in:inbox", "--max", "150"], [list, metaRoute("m0", metaMessage("m0")), metaRoute("m1", metaMessage("m1"))]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(listCalls(r.gmail).map((p) => p.get("maxResults")), ["100"]);
  assert.equal(perMessage(r.gmail).length, 2);
  assert.deepEqual(parsed(r).map((l) => l.id), ["m0", "m1"]);
});

test("meta prints exactly the lines search prints, in the order given", () => {
  const routes = [
    { method: "GET", path: "/messages$", responses: [listPage(0, 3)] },
    metaRoute("m0", metaMessage("m0")),
    metaRoute("m1", metaMessage("m1", { "Message-ID": "" })),
    metaRoute("m2", metaMessage("m2")),
  ];
  const s = run(["search", "personal", "in:inbox"], routes);
  const m = run(["meta", "personal", "m2", "m0", "m1"], routes);
  assert.equal(s.code, 0, s.stderr);
  assert.equal(m.code, 0, m.stderr);
  const byId = Object.fromEntries(parsed(s).map((l) => [l.id, l]));
  const lines = parsed(m);
  assert.deepEqual(lines.map((l) => l.id), ["m2", "m0", "m1"]);
  for (const l of lines) assert.deepEqual(l, byId[l.id]);
  assert.deepEqual(Object.keys(lines[0]), ["id", "threadId", "from", "to", "cc", "reply_to", "subject", "date", "labels", "snippet", "link"]);
  assert.equal(lines[0].reply_to, "help@example.com");
  assert.equal(lines[0].link, "https://mail.google.com/mail/?authuser=you@example.com#search/rfc822msgid:m2%40mail.example.com");
  assert.equal(lines[2].link, "https://mail.google.com/mail/?authuser=you@example.com#all/m1");
  // one format=metadata GET per id, nothing else
  assert.deepEqual(m.gmail.map((e) => [e.method, e.url.split("?")[0]]), [
    ["GET", "/gmail/v1/users/me/messages/m2"], ["GET", "/gmail/v1/users/me/messages/m0"], ["GET", "/gmail/v1/users/me/messages/m1"],
  ]);
  assert.ok(m.gmail.every((e) => e.url.includes("format=metadata")));
});

test("meta skips an id that no longer exists, says so on stderr, and exits 0", () => {
  const gone = { status: 404, body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } } };
  const invalid = { status: 400, body: { error: { code: 400, message: "Invalid id value", status: "INVALID_ARGUMENT" } } };
  const r = run(["meta", "personal", "m0", "gone1", "m1", "bad id"], [
    metaRoute("m0", metaMessage("m0")),
    metaRoute("m1", metaMessage("m1")),
    { method: "GET", path: "/messages/gone1$", responses: [gone] },
    { method: "GET", path: "/messages/bad%20id$", responses: [invalid] },
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(parsed(r).map((l) => l.id), ["m0", "m1"]);
  assert.match(r.stderr, /meta: message gone1 not found in personal, skipped/);
  assert.match(r.stderr, /meta: message bad id not found in personal, skipped/);
  assert.equal(r.gmail.length, 4);
});

test("meta retries rate limits and still fails on other errors", () => {
  const r = run(["meta", "personal", "m0"], [{ method: "GET", path: "/messages/m0$", responses: [rateLimit403(), { body: metaMessage("m0") }] }]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.sleeps.length, 1);
  assert.equal(parsed(r)[0].id, "m0");
  const e = run(["meta", "personal", "m0", "m1"], [{ method: "GET", path: "/messages/m0$", responses: [{ status: 500, body: { error: { code: 500, message: "Backend Error" } } }] }]);
  assert.notEqual(e.code, 0);
  assert.match(e.stderr, /500/);
  assert.equal(e.gmail.length, 1);
});

test("meta without ids prints usage and fails", () => {
  const r = run(["meta", "personal"], []);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage: meta \[account\] <msgId\.\.\.>/);
});
