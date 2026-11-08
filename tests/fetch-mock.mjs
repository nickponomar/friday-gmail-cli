// Preloaded with `node --import` by cli.test.mjs. Replaces fetch with canned
// Gmail/OAuth responses and makes sleeps instant, so the real CLI runs offline.
//   MOCK_SCENARIO  JSON file: { "routes": [{ "method", "path" (regex on the
//                  URL path), "responses": [{ "status", "body", "headers" }] }] }
//                  Each call to a route takes the next response; the last one repeats.
//   MOCK_LOG       file that gets one JSON line per request ({method, url, body})
//                  and per sleep ({sleep: ms}).
import { readFileSync, appendFileSync } from "node:fs";

const { routes } = JSON.parse(readFileSync(process.env.MOCK_SCENARIO, "utf8"));
const log = (entry) => appendFileSync(process.env.MOCK_LOG, JSON.stringify(entry) + "\n");
const calls = new Map();

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const method = (opts.method ?? "GET").toUpperCase();
  log({ method, url: u.pathname + u.search, body: typeof opts.body === "string" ? JSON.parse(opts.body) : null });
  if (u.host === "oauth2.googleapis.com") return Response.json({ access_token: "test-access-token" });
  const i = routes.findIndex((r) => r.method === method && new RegExp(r.path).test(u.pathname));
  if (i < 0) return Response.json({ error: { code: 404, message: `no mock for ${method} ${u.pathname}` } }, { status: 404 });
  const n = calls.get(i) ?? 0;
  calls.set(i, n + 1);
  const r = routes[i].responses[Math.min(n, routes[i].responses.length - 1)];
  const status = r.status ?? 200;
  return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: r.headers });
};

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  log({ sleep: ms });
  return realSetTimeout(fn, 0, ...rest);
};
