import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/lib/core.js";

// Core rollback transaction only; no UI tests and no real account changes.
test("task rollback cancels pending work, handles a sent request, and stays scoped/idempotent", async () => {
  const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (...args) => { const timer = originalTimeout(...args); timer.unref(); return timer; };
  const root = { id: "100000", handle: "author", text: "原帖", url: "https://x.com/author/status/100000" };
  const otherRoot = { ...root, id: "200000" };
  let nextUserId = 900000;
  const row = (id, status, extra = {}) => ({ id, account: "viewer", root, target: { following: false, followingAccount: "viewer", followingAt: Date.now(), handle: id, userId: String(++nextUserId) }, status, owned: true, created: Date.now(), ...extra });
  const histories = [row("ready", "submitted"), row("waiting", "pending", { owned: false }), row("sending", "pending", { owned: false }),
    row("preexisting", "preexisting", { owned: false }), row("failed", "failed", { owned: false }),
    row("oldshared", "blocked", { target: { handle: "shared", userId: "999999" } }),
    row("newshared", "submitted", { root: otherRoot, target: { handle: "shared", userId: "999999" } }),
    row("other", "submitted", { root: otherRoot }), row("otheraccount", "submitted", { account: "other" })];
  const job = name => ({ id: name, historyId: name, kind: "block", account: "viewer", actorId: "990000", origin: "https://x.com", target: histories.find(h => h.id === name).target, status: "pending", sessionId: "session-a", submitted: false });
  const data = { state: { settings: { ...DEFAULTS, paused: true }, whitelist: [], history: histories, jobs: [job("sending"), job("waiting"), { ...job("failed"), status: "failed", submitted: true }],
    sessions: { 1: { id: "session-a", tabId: 1, account: "viewer", root, active: true, results: {}, excluded: [] }, 2: { id: "session-a2", tabId: 2, account: "viewer", root, active: true, results: {}, excluded: [] }, 3: { id: "session-b", tabId: 3, account: "viewer", root: otherRoot, active: true, results: {}, excluded: [] } }, nextActionAt: 0, queueError: "", modelError: "" } };
  let receive, release, posted = 0;
  globalThis.chrome = {
    storage: { local: { setAccessLevel: async () => {}, get: async k => ({ [k]: structuredClone(data[k]) }), set: async value => Object.assign(data, structuredClone(value)) } },
    runtime: { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, onMessage: { addListener: fn => { receive = fn; } }, sendMessage: async () => {} },
    cookies: { get: async ({ name }) => ({ value: name === "ct0" ? "fixture" : "u%3D990000" }), onChanged: { addListener: () => {} } },
    alarms: { create: async () => {}, onAlarm: { addListener: () => {} } },
    tabs: { query: async () => [], onRemoved: { addListener: () => {} }, sendMessage: async () => {} }
  };
  globalThis.fetch = async url => {
    assert.equal(url, "https://x.com/i/api/1.1/blocks/create.json"); posted++;
    return new Promise(resolve => { release = () => resolve({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) }); });
  };
  const ui = { id: "fixture", url: "chrome-extension://fixture/src/manager/manager.html" };
  const rpc = (type, payload = {}, sender = ui) => new Promise((resolve, reject) => receive({ type, ...payload }, sender, result => result.ok ? resolve(result.data) : reject(Error(result.error))));
  const flush = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => originalTimeout(resolve, 2)); } assert.fail("Queue state did not settle"); };
  try {
    await import("../src/background.js");
    await rpc("TOGGLE_PAUSE"); await flush(() => !!release);
    const target = { account: "viewer", rootId: root.id };
    const preview = await rpc("TASK_UNDO_PREVIEW", target);
    assert.equal(preview.ready, 1); assert.equal(preview.cancel, 1); assert.equal(preview.inFlight, 1);
    assert.equal(preview.protected, 2); assert.equal(preview.review, 1); assert.equal(preview.active, 2);
    await assert.rejects(rpc("UNDO_TASK", target, { id: "fixture", url: root.url, tab: { id: 1 } }), /管理面板/);
    await rpc("UNDO_TASK", target);
    assert.equal(data.state.jobs.find(j => j.id === "waiting").status, "cancelled");
    assert.equal(data.state.history.find(h => h.id === "sending").undoRequested, true);
    assert.equal(data.state.sessions[1].stopped, true); assert.equal(data.state.sessions[2].stopped, true);
    assert.equal(data.state.sessions[3].stopped, undefined);
    assert.equal(data.state.history.find(h => h.id === "other").taskWithdrawn, undefined);
    assert.equal(data.state.history.find(h => h.id === "otheraccount").taskWithdrawn, undefined);
    await rpc("UNDO_TASK", target);
    assert.equal(data.state.jobs.filter(j => j.kind === "unblock").length, 1, "repeated click cannot duplicate undo jobs");
    release(); await flush(() => data.state.history.find(h => h.id === "sending").status === "undo_pending");
    assert.equal(posted, 1); assert.equal(data.state.jobs.filter(j => j.kind === "unblock").length, 2);
    await rpc("UNDO_TASK", target);
    assert.equal(data.state.jobs.filter(j => j.kind === "unblock").length, 2);
    await assert.rejects(rpc("RETRY_JOB", { id: "failed" }), /已经撤回/);
  } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; }
});
