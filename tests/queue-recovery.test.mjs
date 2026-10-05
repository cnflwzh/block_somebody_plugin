import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/lib/core.js";

// Restore real persisted queue records, then exercise the worker's management RPCs.
// All browser APIs and relationship reads are local fixtures; no real requests run.
test("worker recovery preserves unknown block outcomes and their reconciliation path", async t => {
  const originalChrome = globalThis.chrome, originalFetch = globalThis.fetch;
  const root = { id: "100000", handle: "author", text: "fixture original post" };
  const specs = [
    { id: "unsent", status: "running", submitted: false },
    { id: "interrupted", status: "running", submitted: true },
    { id: "legacy", status: "failed", submitted: true },
    { id: "legacy-blocked", status: "failed", submitted: true },
    { id: "revoked-absent", status: "failed", submitted: true },
    { id: "shared-absent", status: "failed", submitted: true, manual: true },
    { id: "known-failure", status: "failed", submitted: true, resultKnown: true }
  ];
  const history = specs.map((spec, i) => ({ id: spec.id, status: spec.status, module: "observer", observerOwner: true, stanceOwner: false,
    account: "viewer", target: { userId: String(900000 + i), handle: `target${i}`, following: false, followingAccount: "viewer", followingAt: Date.now() },
    root, reason: "observer", owned: false, created: Date.now(), updated: Date.now() }));
  const jobs = specs.map(spec => ({ ...spec, historyId: spec.id, kind: "block", module: "observer", transport: "worker",
    account: "viewer", actorId: "990000", origin: "https://x.com", target: history.find(h => h.id === spec.id).target }));
  history.find(h => h.id === "shared-absent").stanceOwner = true;
  const data = { state: { settings: { ...DEFAULTS, paused: true, observer: { ...DEFAULTS.observer, enabled: true } },
    history, jobs, whitelist: [], sessions: {}, nextActionAt: 0, queueError: "", modelError: "" } };
  let receive, requests = 0, inspections = 0, holdInspection = false, inspectionStarted, releaseInspection;
  const origin = "chrome-extension://recovery-fixture/";
  const ui = { id: "recovery-fixture", url: origin + "src/manager/manager.html" };
  globalThis.chrome = {
    storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)) } },
    runtime: { id: ui.id, getURL: path => origin + path, onMessage: { addListener: fn => { receive = fn; } }, sendMessage: async () => {} },
    cookies: { onChanged: { addListener: () => {} } },
    alarms: { create: async () => {}, onAlarm: { addListener: () => {} } },
    tabs: { query: async () => [{ id: 1, url: "https://x.com/home" }], onRemoved: { addListener: () => {} }, sendMessage: async (_, message) => {
      if (message.type === "GET_VIEWER") return { account: "viewer" };
      if (message.type === "INSPECT_TARGET") {
        inspections++;
        const answer = { ok: true, target: { ...message.target, blocking: message.target.handle === "target3" } };
        if (holdInspection) return new Promise(resolve => { releaseInspection = () => resolve(answer); inspectionStarted(); });
        return answer;
      }
    } }
  };
  globalThis.fetch = async () => { requests++; throw new Error("No outbound request is allowed in recovery fixtures"); };
  const rpc = (type, payload = {}) => new Promise((resolve, reject) => receive({ type, ...payload }, ui, result => result.ok ? resolve(result.data) : reject(new Error(result.error))));
  const job = id => data.state.jobs.find(j => j.id === id);
  const record = id => data.state.history.find(h => h.id === id);
  try {
    await import("../src/background.js");
    await rpc("SNAPSHOT");
    await t.test("unsent work resumes, while interrupted and legacy unknown work requires verification", async () => {
      assert.equal(job("unsent").status, "pending");
      assert.equal(job("known-failure").status, "failed", "a persisted definite failure remains retryable after restart");
      for (const id of ["interrupted", "legacy", "legacy-blocked"]) {
        assert.equal(job(id).status, "uncertain", id); assert.equal(record(id).status, "uncertain", id);
        assert.equal(job(id).submitted, true, "recovery must retain that the POST was sent");
        await assert.rejects(rpc("RETRY_JOB", { id }), /核对/);
      }
      assert.equal(data.state.queueError, "", "one unknown worker request does not pause unrelated work");
    });
    await t.test("a confirmed absent relationship permits retry without sending during reconciliation", async () => {
      await rpc("RECONCILE", { id: "legacy" });
      assert.equal(job("legacy").status, "failed"); assert.equal(job("legacy").resultKnown, true);
      assert.equal(inspections, 1); assert.equal(requests, 0);
      await rpc("RETRY_JOB", { id: "legacy" });
      assert.equal(job("legacy").status, "pending"); assert.equal(job("legacy").submitted, false);
    });
    await t.test("policy and rule changes cancel only revocable work and retain unknown observer rows", async () => {
      await rpc("SAVE_SETTINGS", { value: { observer: { threshold: .99 } } });
      assert.equal(job("unsent").status, "cancelled");
      assert.equal(job("known-failure").status, "cancelled", "definite failures lose obsolete retry authorization");
      const editor = await rpc("RULE_CONFIG", { module: "observer" });
      editor.rule.prompt += " Require explicit evidence.";
      await rpc("SAVE_RULE_CONFIG", { module: "observer", rule: editor.rule, revision: editor.revision });
      await rpc("SAVE_SETTINGS", { value: { observer: { enabled: false } } });
      const snapshot = await rpc("SNAPSHOT");
      for (const id of ["interrupted", "legacy-blocked"]) {
        assert.equal(job(id).status, "uncertain", id); assert.equal(record(id).status, "uncertain", id);
        assert.equal(record(id).observerOwner, true, "keep the history visible even when evidence has expired");
        assert.equal(snapshot.observer.accounts.find(row => row.historyId === id)?.status, "uncertain");
        await assert.rejects(rpc("RETRY_JOB", { id }), /核对/);
      }
    });
    await t.test("a possibly successful old POST can still be reconciled after disabling observation", async () => {
      await rpc("RECONCILE", { id: "legacy-blocked" });
      assert.equal(record("legacy-blocked").status, "blocked"); assert.equal(job("legacy-blocked").status, "done");
      assert.equal(inspections, 2); assert.equal(requests, 0);
      await assert.rejects(rpc("RETRY_JOB", { id: "legacy-blocked" }));
    });
    await t.test("an absent relationship cannot restore revoked observer retry authorization", async () => {
      await rpc("RECONCILE", { id: "revoked-absent" });
      assert.equal(job("revoked-absent").status, "cancelled"); assert.equal(record("revoked-absent").status, "cancelled");
      assert.equal(record("revoked-absent").observerOwner, false);
      await assert.rejects(rpc("RETRY_JOB", { id: "revoked-absent" }));
      assert.equal(requests, 0);
    });
    await t.test("independent manual ownership survives reconciliation after observer revocation", async () => {
      await rpc("RECONCILE", { id: "shared-absent" });
      assert.equal(job("shared-absent").status, "failed"); assert.equal(job("shared-absent").module, "stance");
      assert.equal(record("shared-absent").observerOwner, false); assert.equal(record("shared-absent").stanceOwner, true);
      await rpc("RETRY_JOB", { id: "shared-absent" });
      assert.equal(job("shared-absent").status, "pending"); assert.equal(requests, 0);
    });
    await t.test("a policy change during a relationship read is checked in the reconciliation transaction", async () => {
      const { change } = await import("../src/lib/store.js");
      await rpc("SAVE_SETTINGS", { value: { observer: { enabled: true } } });
      await change(db => {
        const original = db.history.find(h => h.id === "interrupted");
        db.history.push({ ...structuredClone(original), id: "during-read", observerOwner: true });
        db.jobs.push({ ...structuredClone(db.jobs.find(j => j.id === "interrupted")), id: "during-read", historyId: "during-read", observerAuthorizationRevoked: false });
      });
      holdInspection = true;
      const started = new Promise(resolve => { inspectionStarted = resolve; });
      const pending = rpc("RECONCILE", { id: "during-read" });
      await started;
      await rpc("SAVE_SETTINGS", { value: { observer: { minHits: 4 } } });
      releaseInspection(); await pending; holdInspection = false;
      assert.equal(job("during-read").status, "cancelled"); assert.equal(record("during-read").status, "cancelled");
      await assert.rejects(rpc("RETRY_JOB", { id: "during-read" }));
      assert.equal(requests, 0);
    });
  } finally {
    await new Promise(resolve => setTimeout(resolve, 150));
    globalThis.chrome = originalChrome; globalThis.fetch = originalFetch;
  }
});
