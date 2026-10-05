import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { xSession, postBlock } from "../src/lib/x-block.js";

// Core HTTP adapter only: no UI automation, real credentials or outbound requests.
test("background block submits once and accepts HTTP success without relationship fields", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, ...options }); return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id_str: "900001" }) }; };
  try {
    const result = await postBlock({ handle: "target", userId: "900001" }, { origin: "https://x.com", actorId: "990000", csrf: "fixture" });
    assert.equal(result.accepted, true); assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://x.com/i/api/1.1/blocks/create.json");
    assert.equal(requests[0].method, "POST"); assert.equal(requests[0].body, "user_id=900001");
    assert.equal(requests[0].credentials, "include");
  } finally { globalThis.fetch = original; }
});

test("HTTP failures remain distinct from unknown POST outcomes; neither is automatically retried", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [404, 500, 401, 403, 429]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return { ok: false, status, headers: new Headers({ "Retry-After": "90" }), json: async () => { throw Error("non-JSON error"); } }; };
      const result = await postBlock({ handle: "target" }, { origin: "https://x.com", actorId: "990000", csrf: "fixture" });
      assert.equal(result.ok, false); assert.equal(calls, 1); assert.equal(result.status, status);
      assert.notEqual(result.uncertain, true, "an HTTP error has a definite response");
      assert.equal(result.pauseQueue, [401, 403, 429].includes(status)); assert.match(result.error, new RegExp(String(status)));
      assert.equal(result.retryAfterMs, 90000);
    }
    let calls = 0; globalThis.fetch = async () => { calls++; throw Error("timeout"); };
    const result = await postBlock({ handle: "target" }, { origin: "https://x.com", actorId: "990000", csrf: "fixture" });
    assert.equal(result.ok, false); assert.equal(result.uncertain, true);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("empty 2xx succeeds, explicit API errors fail, and handle fallback needs no lookup", async () => {
  const original = globalThis.fetch;
  let body;
  try {
    globalThis.fetch = async (_, options) => { body = options.body; return { ok: true, status: 204, headers: new Headers(), json: async () => { throw Error("empty"); } }; };
    assert.equal((await postBlock({ handle: "target" }, { origin: "https://x.com", actorId: "990000", csrf: "fixture" })).accepted, true);
    assert.equal(body, "screen_name=target");
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ errors: [{ code: 1 }] }) });
    assert.equal((await postBlock({ handle: "target" }, { origin: "https://x.com", actorId: "990000", csrf: "fixture" })).ok, false);
  } finally { globalThis.fetch = original; }
});

test("cookie binding accepts only X origins and requires an identifiable logged-in account", async () => {
  const previous = globalThis.chrome;
  let twid = '"u%3D990000"';
  globalThis.chrome = { cookies: { get: async ({ name }) => ({ value: name === "ct0" ? "fixture-csrf" : twid }) } };
  try {
    assert.equal((await xSession()).actorId, "990000");
    await assert.rejects(xSession("https://example.org"));
    twid = "invalid"; await assert.rejects(xSession());
  } finally { globalThis.chrome = previous; }
});
