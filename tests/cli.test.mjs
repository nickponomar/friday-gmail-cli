// Runs the real CLI (gmail.js) offline against canned API responses
// (tests/fetch-mock.mjs). Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI = fileURLToPath(new URL("../gmail.js", import.meta.url));
const MOCK = pathToFileURL(fileURLToPath(new URL("./fetch-mock.mjs", import.meta.url))).href;

function run(args, routes, { state, tz = "UTC" } = {}) {
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
  if (state) {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "state.json"), JSON.stringify(state));
  }
  const r = spawnSync(process.execPath, ["--import", MOCK, CLI, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      TZ: tz,
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
  const calendar = log.filter((e) => e.url?.startsWith("/calendar/"));
  const lines = r.stdout.trim() ? r.stdout.trim().split("\n") : [];
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, lines, gmail, calendar, log, sleeps: log.filter((e) => "sleep" in e).map((e) => e.sleep) };
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

// ---------- calendar (read-only) ----------

const midnightUTC = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const qs = (entry) => new URL("https://x" + entry.url).searchParams;

const TIMED = {
  id: "ev1", status: "confirmed", htmlLink: "https://calendar.google.com/event?eid=ev1",
  summary: "Weekly sync", location: "Room 1", recurringEventId: "series1",
  start: { dateTime: "2026-11-10T09:00:00+01:00" }, end: { dateTime: "2026-11-10T09:30:00+01:00" },
  organizer: { email: "lead@example.com" },
  attendees: [
    { email: "lead@example.com", displayName: "Lead", responseStatus: "accepted", organizer: true },
    { email: "you@example.com", responseStatus: "tentative", self: true },
    { email: "guest@example.com", responseStatus: "needsAction", optional: true },
  ],
  conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }, { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] },
  description: "Agenda: numbers", creator: { email: "lead@example.com" }, created: "2026-01-01T00:00:00Z", updated: "2026-11-01T00:00:00Z",
  recurrence: ["RRULE:FREQ=WEEKLY"],
};
const ALL_DAY = {
  id: "ev2", status: "confirmed", summary: "Offsite", start: { date: "2026-11-11" }, end: { date: "2026-11-12" },
  organizer: { email: "you@example.com", self: true }, hangoutLink: "https://meet.google.com/xyz",
};

test("calendars lists every calendar across pages", () => {
  const r = run(["calendars", "personal"], [
    { method: "GET", path: "/calendar/v3/users/me/calendarList$", responses: [
      { body: { items: [{ id: "you@example.com", summary: "You", primary: true, accessRole: "owner", timeZone: "Europe/Berlin" }], nextPageToken: "p2" } },
      { body: { items: [{ id: "team@group.calendar.google.com", summary: "Team", summaryOverride: "Team (mine)", accessRole: "reader", timeZone: "UTC" }] } },
    ] },
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.lines.map((l) => JSON.parse(l)), [
    { id: "you@example.com", name: "You", primary: true, access: "owner", time_zone: "Europe/Berlin" },
    { id: "team@group.calendar.google.com", name: "Team (mine)", primary: false, access: "reader", time_zone: "UTC" },
  ]);
  assert.equal(qs(r.calendar[1]).get("pageToken"), "p2");
});

test("events defaults to the primary calendar, today for 7 days, recurring expanded", () => {
  const r = run(["events", "personal"], [
    { method: "GET", path: "/calendar/v3/calendars/primary/events$", responses: [{ body: { items: [TIMED, ALL_DAY] } }] },
  ]);
  assert.equal(r.code, 0, r.stderr);
  const q = qs(r.calendar[0]);
  const today = midnightUTC();
  assert.equal(q.get("timeMin"), today.toISOString());
  assert.equal(q.get("timeMax"), new Date(today.getTime() + 7 * 86400000).toISOString());
  assert.equal(q.get("singleEvents"), "true");
  assert.equal(q.get("orderBy"), "startTime");
  assert.equal(q.get("maxResults"), "100");
  const [timed, allDay] = r.lines.map((l) => JSON.parse(l));
  assert.deepEqual(timed, {
    id: "ev1", calendar: "primary", start: "2026-11-10T09:00:00+01:00", end: "2026-11-10T09:30:00+01:00", all_day: false,
    title: "Weekly sync", location: "Room 1", organizer: "lead@example.com",
    attendees: [
      { email: "lead@example.com", name: "Lead", response: "accepted" },
      { email: "you@example.com", name: "", response: "tentative" },
      { email: "guest@example.com", name: "", response: "needsAction", optional: true },
    ],
    my_response: "tentative", meet: "https://meet.google.com/abc-defg-hij", status: "confirmed", recurring: true,
    link: "https://calendar.google.com/event?eid=ev1",
  });
  assert.equal(timed.description, undefined);
  assert.equal(allDay.all_day, true);
  assert.equal(allDay.start, "2026-11-11");
  assert.equal(allDay.my_response, "organizer");
  assert.equal(allDay.meet, "https://meet.google.com/xyz");
  assert.equal(allDay.recurring, false);
});

test("events --from/--to are local days and --to includes its whole day; --calendar and --q pass through", () => {
  const r = run(["events", "personal", "--from", "2026-11-10", "--to", "2026-11-12", "--calendar", "team@example.com", "--q", "budget"], [
    { method: "GET", path: "/calendar/v3/calendars/team%40example.com/events$", responses: [{ body: { items: [] } }] },
  ], { tz: "Europe/Berlin" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "");
  const q = qs(r.calendar[0]);
  assert.equal(q.get("timeMin"), "2026-11-09T23:00:00.000Z");
  assert.equal(q.get("timeMax"), "2026-11-12T23:00:00.000Z");
  assert.equal(q.get("q"), "budget");
});

test("events --from <date-time> --days N", () => {
  const r = run(["events", "personal", "--from", "2026-11-10T08:00:00+01:00", "--days", "2"], [
    { method: "GET", path: "/calendar/v3/calendars/primary/events$", responses: [{ body: { items: [] } }] },
  ]);
  assert.equal(r.code, 0, r.stderr);
  const q = qs(r.calendar[0]);
  assert.equal(q.get("timeMin"), "2026-11-10T07:00:00.000Z");
  assert.equal(q.get("timeMax"), "2026-11-12T07:00:00.000Z");
});

test("events follows pages and stops at --max", () => {
  const ev = (id) => ({ ...ALL_DAY, id });
  const r = run(["events", "personal", "--max", "4"], [
    { method: "GET", path: "/calendar/v3/calendars/primary/events$", responses: [
      { body: { items: [ev("a"), ev("b"), ev("c")], nextPageToken: "p2" } },
      { body: { items: [ev("d"), ev("e")], nextPageToken: "p3" } },
    ] },
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.lines.map((l) => JSON.parse(l).id), ["a", "b", "c", "d"]);
  assert.equal(r.calendar.length, 2);
  assert.equal(qs(r.calendar[0]).get("maxResults"), "4");
  assert.equal(qs(r.calendar[1]).get("maxResults"), "1");
  assert.equal(qs(r.calendar[1]).get("pageToken"), "p2");
});

test("events rejects bad ranges before calling the API", () => {
  const cases = [
    [["--from", "12.11.2026"], /--from must be YYYY-MM-DD or an ISO date-time/],
    [["--from", "2026-11-12", "--to", "2026-11-10"], /end of the range must be after its start/],
    [["--days", "0"], /--days must be a positive number/],
    [["--max", "x"], /--max must be a positive number/],
    [["--calendar"], /--calendar needs a value/],
  ];
  for (const [extra, msg] of cases) {
    const r = run(["events", "personal", ...extra], []);
    assert.equal(r.code, 1, extra.join(" "));
    assert.match(r.stderr, msg);
    assert.equal(r.calendar.length, 0);
  }
});

test("event returns one event in full", () => {
  const r = run(["event", "personal", "--calendar", "team@example.com", "ev1"], [
    { method: "GET", path: "/calendar/v3/calendars/team%40example.com/events/ev1$", responses: [{ body: { ...TIMED, attachments: [{ title: "Deck", fileUrl: "https://drive.google.com/x" }] } }] },
  ]);
  assert.equal(r.code, 0, r.stderr);
  const e = JSON.parse(r.stdout);
  assert.equal(e.calendar, "team@example.com");
  assert.equal(e.description, "Agenda: numbers");
  assert.deepEqual(e.recurrence, ["RRULE:FREQ=WEEKLY"]);
  assert.equal(e.creator, "lead@example.com");
  assert.deepEqual(e.attachments, [{ title: "Deck", url: "https://drive.google.com/x" }]);
  assert.equal(e.visibility, "default");

  const u = run(["event", "personal"], []);
  assert.equal(u.code, 1);
  assert.match(u.stderr, /usage: event \[account\] <eventId>/);
});

test("freebusy queries the given calendars (default primary) and prints busy slots", () => {
  const r = run(["freebusy", "personal", "--from", "2026-11-10", "--days", "1", "--calendar", "you@example.com", "--calendar", "team@example.com"], [
    { method: "POST", path: "/calendar/v3/freeBusy$", responses: [{ body: { calendars: {
      "you@example.com": { busy: [{ start: "2026-11-10T09:00:00Z", end: "2026-11-10T10:00:00Z" }] },
      "team@example.com": { busy: [], errors: [{ domain: "global", reason: "notFound" }] },
    } } }] },
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calendar[0].body, {
    timeMin: "2026-11-10T00:00:00.000Z", timeMax: "2026-11-11T00:00:00.000Z",
    items: [{ id: "you@example.com" }, { id: "team@example.com" }],
  });
  const [mine, team] = r.lines.map((l) => JSON.parse(l));
  assert.deepEqual(mine.busy, [{ start: "2026-11-10T09:00:00Z", end: "2026-11-10T10:00:00Z" }]);
  assert.deepEqual(team.errors, ["notFound"]);

  const d = run(["freebusy", "personal"], [{ method: "POST", path: "/calendar/v3/freeBusy$", responses: [{ body: { calendars: {} } }] }]);
  assert.deepEqual(d.calendar[0].body.items, [{ id: "primary" }]);
});

test("calendar commands only read: GET everywhere except the freeBusy query", () => {
  const routes = [
    { method: "GET", path: "/calendar/v3/", responses: [{ body: { items: [TIMED] } }] },
    { method: "POST", path: "/calendar/v3/freeBusy$", responses: [{ body: { calendars: {} } }] },
  ];
  const all = [["calendars", "personal"], ["events", "personal"], ["event", "personal", "ev1"], ["freebusy", "personal"]].flatMap((a) => run(a, routes).calendar);
  assert.equal(all.length, 4);
  for (const e of all) assert.ok(e.method === "GET" || e.url === "/calendar/v3/freeBusy", `${e.method} ${e.url}`);
});

test("a token without the calendar scope gets a fix-it message, not a raw 403", () => {
  const scope403 = { status: 403, body: { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } } };
  const r = run(["events", "personal"], [{ method: "GET", path: "/calendar/v3/", responses: [scope403] }]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no calendar access\. Run auth-url personal and auth-exchange again, then replace TEST_TOKEN_PERSONAL/);
  assert.doesNotMatch(r.stderr, /insufficient authentication scopes/);
  assert.equal(r.sleeps.length, 0);

  const disabled = { status: 403, body: { error: { code: 403, message: "Calendar API has not been used", errors: [{ reason: "accessNotConfigured" }] } } };
  const d = run(["calendars", "personal"], [{ method: "GET", path: "/calendar/v3/", responses: [disabled] }]);
  assert.equal(d.code, 1);
  assert.match(d.stderr, /Google Calendar API is not enabled/);
});

test("calendar requests get the same rate-limit retry", () => {
  const r = run(["calendars", "personal"], [{ method: "GET", path: "/calendar/v3/", responses: [rateLimit403(), { body: { items: [] } }] }]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.sleeps.length, 1);
  assert.match(r.stderr, /rate limited \(rateLimitExceeded\) on users\/me\/calendarList, retry 1\/7/);
});

// ---------- auth ----------

test("auth-url asks for gmail.modify and calendar.readonly, nothing else", () => {
  const r = run(["auth-url", "personal"], []);
  assert.equal(r.code, 0, r.stderr);
  const url = new URL(r.stdout.match(/https:\/\/accounts\.google\.com\/\S+/)[0]);
  assert.deepEqual(url.searchParams.get("scope").split(" "), [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.readonly",
  ]);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("login_hint"), "you@example.com");
});

test("auth-exchange reports whether the new token can read the calendar", () => {
  const profile = { method: "GET", path: "/gmail/v1/users/me/profile$", responses: [{ body: { emailAddress: "you@example.com" } }] };
  const token = (scope) => ({ method: "POST", path: "/token$", responses: [{ body: { access_token: "a", refresh_token: "r", scope } }] });
  const both = run(["auth-exchange", "test-code"], [profile, token("https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.readonly")], { state: { pkce_verifier: "v" } });
  assert.equal(both.code, 0, both.stderr);
  const out = JSON.parse(both.stdout);
  assert.equal(out.account, "personal");
  assert.equal(out.calendar, true);
  assert.equal(out.refresh_token, "r");
  const mailOnly = run(["auth-exchange", "test-code"], [profile, token("https://www.googleapis.com/auth/gmail.modify")], { state: { pkce_verifier: "v" } });
  assert.equal(JSON.parse(mailOnly.stdout).calendar, false);
});
