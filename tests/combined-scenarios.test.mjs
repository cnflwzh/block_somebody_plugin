import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/lib/core.js";
import { ACCOUNT_REVIEW_VERSION } from "../src/lib/observer-review.js";

// Exercise the real worker RPC, IndexedDB, parser, request builder and decision path.
// Only the Chrome host and external HTTP responses are fixtures; no real network runs.
test("combined upper-bound, incomplete-context and persistent normal-account scenarios", async t => {
  const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome, originalNow = Date.now;
  let clock = originalNow(), receive, choice = "ai_generated", confidence = .99, actor = "viewer";
  let pages = [], requests = [], modelRequests = [], blockRequests = 0;
  const rename = new Map();
  Date.now = () => clock;
  const origin = "chrome-extension://combined-fixture/";
  const web = { id: "combined-fixture", url: "https://x.com/home", frameId: 0, tab: { id: 1 } };
  const ui = { id: "combined-fixture", url: `${origin}src/manager/manager.html` };
  const data = { jevKey: "synthetic-key", state: { settings: { ...DEFAULTS, observer: { ...DEFAULTS.observer, enabled: true, mode: "combined", reviewMinReplies: 7 } },
    whitelist: [], history: [], jobs: [], sessions: {}, nextActionAt: clock + 365 * 86400000, queueError: "", modelError: "" } };
  globalThis.chrome = {
    runtime: { id: "combined-fixture", getURL: p => origin + p, onMessage: { addListener: fn => { receive = fn; } }, sendMessage: async () => {} },
    storage: { local: { setAccessLevel: async () => {}, get: async k => ({ [k]: structuredClone(data[k]) }), set: async v => Object.assign(data, structuredClone(v)) } },
    cookies: { get: async ({ name }) => ({ value: name === "ct0" ? "synthetic-csrf" : "u=990000" }), onChanged: { addListener: () => {} } },
    alarms: { get: async () => ({}), create: async () => {}, onAlarm: { addListener: () => {} } },
    tabs: { get: async () => ({ id: 1, url: web.url }), query: async () => [], onRemoved: { addListener: () => {} }, sendMessage: async (id, m) => m.type === "GET_VIEWER" ? { account: actor } : undefined }
  };
  const rpc = (type, payload = {}, sender = web) => new Promise((resolve, reject) => receive({ type, ...payload }, sender, r => r.ok ? resolve(r.data) : reject(new Error(r.error))));
  const handle = id => rename.get(id) || `u${id}`;
  function pair(userId, n) {
    const rootId = String(Number(userId) * 100 + n * 2), replyId = String(Number(rootId) + 1);
    const root = { id: rootId, conversationId: rootId, handle: "sourceauthor", userId: "800000", text: `Original subject ${n} for ${userId}` };
    const reply = { id: replyId, parentId: rootId, conversationId: rootId, handle: handle(userId), name: "Synthetic account", userId, text: `Synthetic reply ${n} to subject ${n}`,
      following: false, followingAccount: actor, followingAt: clock, blueVerified: true };
    return { root, reply, ancestors: [] };
  }
  function apiPost(post) {
    return { __typename: "Tweet", rest_id: post.id,
      core: { user_results: { result: { rest_id: post.userId, core: { screen_name: post.handle, name: post.name || "Source" },
        profile_bio: { description: "Synthetic public biography" }, is_blue_verified: true, relationship_perspectives: { following: false } } } },
      legacy: { full_text: post.text, conversation_id_str: post.conversationId, in_reply_to_status_id_str: post.parentId, created_at: new Date(clock - 60000).toUTCString() } };
  }
  function entries(userId, count, offset = 0) {
    return Array.from({ length: count }, (_, i) => pair(userId, i + offset)).flatMap(c => [apiPost(c.root), apiPost(c.reply)]);
  }
  function observation(userId, n = 0) { return { account: actor, ...pair(userId, n) }; }
  function resetPages(value) { clock += 7200000; pages = value; requests = []; modelRequests = []; }
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.origin === "https://x.com" && u.pathname.endsWith("/UserRepliesTimeline")) {
      const variables = JSON.parse(u.searchParams.get("variables")); requests.push(variables);
      clock += 4000; // Request spacing remains checked, without a wall-clock sleep.
      const value = pages[variables.cursor ? 1 : 0] || [];
      if (typeof value === "number") return new Response("Synthetic failure", { status: value, headers: { "retry-after": "60" } });
      return Response.json({ data: { user: { result: { timeline: { timeline: { instructions: [{ entries: value }] } } } } } });
    }
    if (u.origin === "https://x.com") { blockRequests++; throw new Error("Unexpected account mutation"); }
    assert.equal(u.href, "https://api.typesafe.ai/v1/systemone");
    const request = JSON.parse(options.body); modelRequests.push(request);
    assert.ok(request.questions.stance.instructions.includes(ACCOUNT_REVIEW_VERSION));
    assert.equal(/覆盖至少\d+条|命中占比75|75%/.test(request.questions.stance.instructions), false);
    return Response.json({ answers: { stance: { type: "choice", choice, confidence,
      probabilities: Object.fromEntries(["ai_generated", "human_like", "uncertain"].map(label => [label, label === choice ? .98 : .01])) } } });
  };
  try {
    await import("../src/background.js");
    await rpc("DEBUG_DRY_RUN", { enabled: true });
    await t.test("limit 7 with only 5 usable replies immediately sends one five-sample assessment", async () => {
      const id = "930001"; resetPages([entries(id, 5)]);
      const input = observation(id);
      const [result, duplicate] = await Promise.all([rpc("OBSERVE_REPLY", input), rpc("OBSERVE_REPLY", input)]);
      assert.equal(duplicate.status, "simulated");
      assert.equal(requests.length, 1); assert.equal(modelRequests.length, 1);
      const body = JSON.parse(modelRequests[0].state);
      assert.equal(body.samples.length, 5); assert.equal(result.status, "simulated");
      const snap = await rpc("SNAPSHOT", {}, ui);
      assert.equal(snap.observer.accounts.find(r => r.userId === id).accountReview.samples, 5);
    });
    await t.test("missing parent is skipped and the next page supplies valid replies", async () => {
      const id = "930002", bad = pair(id, 99); bad.reply.parentId = "999999999"; bad.reply.text = "MISSING_PARENT_MUST_NOT_REACH_MODEL";
      resetPages([[apiPost(bad.root), apiPost(bad.reply), ...entries(id, 2), { cursorType: "Bottom", value: "next" }], entries(id, 3, 2)]);
      const result = await rpc("OBSERVE_REPLY", observation(id));
      assert.deepEqual(requests.map(r => r.cursor || "first"), ["first", "next"]);
      assert.equal(modelRequests.length, 1); assert.equal(JSON.parse(modelRequests[0].state).samples.length, 5);
      assert.equal(modelRequests[0].state.includes("MISSING_PARENT_MUST_NOT_REACH_MODEL"), false);
      assert.equal(result.status, "simulated");
    });
    await t.test("failure of page two retains page one's five complete samples", async () => {
      const id = "930003"; resetPages([[...entries(id, 5), { cursorType: "Bottom", value: "next" }], 429]);
      const result = await rpc("OBSERVE_REPLY", observation(id));
      assert.equal(requests.length, 2); assert.equal(modelRequests.length, 1);
      assert.equal(JSON.parse(modelRequests[0].state).samples.length, 5); assert.equal(result.status, "simulated");
    });
    await t.test("normal account is persistent, survives expiry/cache clearing and follows stable ID", async () => {
      const id = "930004"; choice = "human_like";
      await rpc("DEBUG_DRY_RUN", { enabled: false });
      resetPages([entries(id, 5)]);
      await rpc("OBSERVE_REPLY", observation(id));
      assert.equal(modelRequests.length, 1);
      assert.ok((await rpc("OBSERVER_NORMAL_LIST", {}, ui)).some(r => r.userId === id));
      requests = []; modelRequests = [];
      assert.equal((await rpc("OBSERVE_REPLY", observation(id, 6))).why, "normal-account");
      await rpc("CLEAR_JEV_CACHE", {}, ui);
      clock += 40 * 86400000;
      const reopened = await import("../src/lib/observer-store.js?reopened-normal-check");
      assert.ok(await reopened.readNormalAccount(actor, id), "a fresh database accessor still sees the durable entry");
      rename.set(id, "renamedfixture");
      assert.equal((await rpc("OBSERVE_REPLY", observation(id, 7))).why, "normal-account");
      assert.equal(requests.length, 0); assert.equal(modelRequests.length, 0);
      // A different stable ID with the same handle must not inherit the exemption.
      const other = "930005"; rename.set(other, "renamedfixture"); resetPages([entries(other, 1)]);
      await rpc("OBSERVE_REPLY", observation(other)); assert.equal(modelRequests.length, 1);
      await rpc("OBSERVER_NORMAL_REMOVE", { account: actor, userId: id }, ui);
      resetPages([entries(id, 5)]);
      await rpc("OBSERVE_REPLY", observation(id));
      assert.equal(requests.length, 1); assert.equal(modelRequests.length, 1, "explicit removal allows analysis again");
    });
    await t.test("unknown and simulated natural classifications do not enter the durable list", async () => {
      choice = "uncertain"; const id = "930006"; resetPages([entries(id, 1)]);
      await rpc("OBSERVE_REPLY", observation(id)); assert.equal(modelRequests.length, 1);
      assert.equal((await rpc("OBSERVER_NORMAL_LIST", {}, ui)).some(r => r.userId === id), false);
      choice = "human_like"; confidence = .5;
      const lowConfidence = "930008"; resetPages([entries(lowConfidence, 1)]);
      await rpc("OBSERVE_REPLY", observation(lowConfidence)); assert.equal(modelRequests.length, 1);
      assert.equal((await rpc("OBSERVER_NORMAL_LIST", {}, ui)).some(r => r.userId === lowConfidence), false);
      confidence = .99;
      choice = "human_like"; await rpc("DEBUG_DRY_RUN", { enabled: true });
      const simulated = "930007"; resetPages([entries(simulated, 1)]);
      await rpc("OBSERVE_REPLY", observation(simulated)); assert.equal(modelRequests.length, 1);
      assert.equal((await rpc("OBSERVER_NORMAL_LIST", {}, ui)).some(r => r.userId === simulated), false);
    });
    assert.equal(blockRequests, 0);
  } finally {
    // Worker notifications are debounced by 100 ms. Let the final notification finish
    // while the host fixture still exists, rather than generating a teardown rejection.
    await new Promise(resolve => setTimeout(resolve, 200));
    globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; Date.now = originalNow;
  }
});
