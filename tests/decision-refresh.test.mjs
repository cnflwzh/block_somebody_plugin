import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, DECISION_VERSION, buildRequest } from "../src/lib/core.js";
import { requestKey } from "../src/lib/jev-cache.js";

// Core policy migration: an existing high score must enqueue without a second model call.
test("saved media-vetoed score is re-evaluated once without Jev or duplicate jobs", async () => {
  const root = { id: "100000", handle: "author", text: "持续学习输出", conversationId: "100000", parentId: "", hasMedia: true, incomplete: false };
  const reply = { following: false, followingAccount: "viewer", followingAt: Date.now(), id: "100001", handle: "reader", text: "坚持坚持再坚持", conversationId: root.id, parentId: root.id, hasMedia: false, incomplete: false };
  const settings = { ...DEFAULTS, high: .87, confidence: .72 };
  const digest = await requestKey(buildRequest(root, reply, null, settings.model));
  const session = { id: "saved-task", tabId: 1, account: "viewer", root, active: true, pageReady: true, sortRequired: true, paused: false, excluded: [], count: 1, results: {
    [reply.id]: { action: "keep", label: "support", support: .98, confidence: .97, model: settings.model, promptVersion: "2", analyzedAt: Date.now(), requestKey: digest, handle: reply.handle }
  } };
  const data = { jevKey: "fixture-only", state: { settings, sessions: { 1: session }, history: [], jobs: [], whitelist: [], modelError: "", queueError: "", nextActionAt: Date.now() + 3600000 } };
  let receive;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail("Re-evaluating a matching saved score must not call Jev or X"); };
  globalThis.chrome = {
    storage: { local: { setAccessLevel: async () => {}, get: async k => ({ [k]: structuredClone(data[k]) }), set: async x => Object.assign(data, structuredClone(x)) } },
    runtime: { id: "fixture", getURL: p => "chrome-extension://fixture/" + p, onMessage: { addListener: fn => { receive = fn; } }, sendMessage: async () => {} },
    cookies: { onChanged: { addListener: () => {} } },
    alarms: { create: async () => {}, onAlarm: { addListener: () => {} } },
    tabs: { get: async () => ({ url: "https://x.com/author/status/100000" }), query: async () => [], sendMessage: async () => {}, onRemoved: { addListener: () => {} } }
  };
  const sender = { id: "fixture", url: "https://x.com/home", tab: { id: 1 } };
  const rpc = (type, payload = {}) => new Promise((resolve, reject) => receive({ type, ...payload }, sender, r => r.ok ? resolve(r.data) : reject(Error(r.error))));
  try {
    await import("../src/background.js");
    const request = { sessionId: session.id, account: "viewer", reply, ancestors: [] };
    const result = await rpc("CLASSIFY", request);
    assert.equal(result.action, "block"); assert.equal(result.decisionVersion, DECISION_VERSION);
    assert.equal(data.state.jobs.length, 1); assert.equal(data.state.jobs[0].status, "pending");
    assert.equal(data.state.sessions[1].count, 1);
    assert.equal((await rpc("CLASSIFY", request)).historyId, result.historyId);
    assert.equal(data.state.jobs.length, 1);
    await rpc("WHITELIST_ADD", { handle: reply.handle });
    assert.equal((await rpc("CLASSIFY", request)).action, "skip");
    assert.equal(data.state.jobs[0].status, "cancelled");
  } finally { globalThis.fetch = originalFetch; }
});
