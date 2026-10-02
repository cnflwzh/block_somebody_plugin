import { testI18n } from "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/content/x-client.js", import.meta.url), "utf8");
/** Run the real account adapter against local HTTP substitutes. No browser UI tests. */
function adapter({ user = "viewer", blocking = true, mutate, allowed = true, postBlocking } = {}) {
  let receive;
  const requests = [], grants = [];
  const context = { URL, URLSearchParams, AbortSignal, setTimeout, clearTimeout, BlockSBI18n: testI18n,
    location: { origin: "https://x.com" }, document: { cookie: "ct0=fixture-csrf", querySelector: () => ({ innerText: `Current account\n@${user}` }) },
    chrome: { runtime: { id: "fixture", onMessage: { addListener: fn => { receive = fn; } }, sendMessage: async m => { grants.push(m); return { ok: true, data: allowed }; } } },
    fetch: async (url, options) => {
      requests.push({ url: String(url), ...options });
      if (options.method === "POST" && mutate) return mutate(url, options);
      if (String(url).includes("friendships/show")) return { ok: true, status: 200, headers: new Headers(), json: async () => ({ relationship: { source: { screen_name: "viewer", blocking: requests.some(r => r.method === "POST") && postBlocking !== undefined ? postBlocking : blocking }, target: { screen_name: "target", id_str: "900001" } } }) };
      throw new Error("Unexpected endpoint in account adapter");
    }
  };
  runInNewContext(source, context);
  return { requests, grants, execute: (kind = "unblock", target = { handle: "target", userId: "900001" }) => new Promise(resolve => receive({ type: "EXECUTE_ACTION", job: { id: "job", account: "viewer", kind, target } }, { id: "fixture" }, resolve)) };
}
test("undo skips a target that is already unblocked", async () => {
  const a = adapter({ blocking: false }); const r = await a.execute();
  assert.equal(r.ok, true); assert.equal(a.requests.some(r => r.method === "POST"), false);
});
test("undo verifies identity then submits the numeric target ID once", async () => {
  const a = adapter({ mutate: async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ screen_name: "target", id_str: "900001", blocking: false }) }) });
  assert.equal((await a.execute()).ok, true);
  const post = a.requests.filter(r => r.method === "POST"); assert.equal(post.length, 1); assert.equal(post[0].body, "user_id=900001");
  assert.equal(post[0].credentials, "same-origin"); assert.equal(a.grants.at(-1).type, "ACTION_SUBMIT");
});
test("adapter stops account mismatch and target ID reuse before mutation", async () => {
  const switched = adapter({ user: "other" }); assert.equal((await switched.execute()).ok, false); assert.equal(switched.requests.length, 0);
  const reused = adapter(); assert.equal((await reused.execute("unblock", { handle: "target", userId: "900002" })).ok, false); assert.equal(reused.requests.some(r => r.method === "POST"), false);
});
test("adapter rechecks cancellation before account lookup", async () => {
  const a = adapter({ allowed: false }); assert.equal((await a.execute()).cancelled, true); assert.equal(a.requests.length, 0);
});
test("adapter marks interrupted mutations uncertain and never retries", async () => {
  const a = adapter({ mutate: async () => { throw new Error("fixture lost response"); } });
  const r = await a.execute(); assert.equal(r.ok, false); assert.equal(r.uncertain, true); assert.equal(a.requests.filter(r => r.method === "POST").length, 1);
});
test("relationship lookup avoids the retired users/show endpoint", async () => {
  const a = adapter({ blocking: false }); const r = await a.execute();
  assert.equal(a.requests.length, 1); assert.ok(a.requests[0].url.includes("friendships/show"));
});
test("successful POST without blocking flag is confirmed by relationship readback", async () => {
  const a = adapter({ postBlocking: false, mutate: async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ screen_name: "target", id_str: "900001" }) }) });
  const r = await a.execute(); assert.equal(r.ok, true); assert.equal(r.target.blocking, false);
  assert.equal(a.requests.filter(r => r.method === "POST").length, 1);
  assert.equal(a.requests.filter(r => r.url.includes("friendships/show")).length, 2);
});
test("unconfirmed POST remains uncertain when readback does not match", async () => {
  const a = adapter({ postBlocking: true, mutate: async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ screen_name: "target", id_str: "900001" }) }) });
  const r = await a.execute(); assert.equal(r.ok, false); assert.equal(r.uncertain, true);
  assert.equal(a.requests.filter(r => r.method === "POST").length, 1);
});
test("rate limits retain a retry delay without reporting success", async () => {
  const a = adapter({ mutate: async () => ({ ok: false, status: 429, headers: new Headers({ "Retry-After": "90" }), json: async () => ({ errors: [{ code: 88 }] }) }) });
  const r = await a.execute(); assert.equal(r.ok, false); assert.equal(r.uncertain, false); assert.equal(r.retryAfterMs, 90000);
});
