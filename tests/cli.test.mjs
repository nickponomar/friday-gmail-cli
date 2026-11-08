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

test("label still creates a missing label (unchanged)", () => {
  const r = run(["label", "personal", "brand-new", "m1"], [
    LABELS,
    { method: "POST", path: "/labels$", responses: [{ body: { id: "Label_new", name: "brand-new" } }] },
    { method: "POST", path: "/messages/m1/modify$", responses: [{ body: { id: "m1" } }] },
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "labeled 1");
  assert.deepEqual(r.gmail.find((e) => e.url.endsWith("/modify")).body.addLabelIds, ["Label_new"]);
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
