import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/lib/core.js";

test("passive observer persists distinct evidence, queues independently, and honors cancellation and dry-run", async t => {
  let receive, jevCalls = 0, blockCalls = 0, modelChoice = "spam", serviceFailure = false;
  const data = { jevKey: "fixture-key-not-a-secret", state: { settings: { ...DEFAULTS, observer: { ...DEFAULTS.observer, enabled: true } }, whitelist: [], history: [], jobs: [], sessions: {}, nextActionAt: Date.now() + 3600000, queueError: "", modelError: "" } };
  const originalFetch = globalThis.fetch;
  const origin = "chrome-extension://observer-fixture/";
  const web = { id: "observer-fixture", url: "https://x.com/home", tab: { id: 1 } }, ui = { id: "observer-fixture", url: `${origin}src/manager/manager.html` };
  let tabUrl = web.url;
  globalThis.chrome = {
    runtime: { id: "observer-fixture", getURL: path => origin + path, onMessage: { addListener: fn => { receive = fn; } }, sendMessage: async () => {} },
    storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)) } },
    cookies: { get: async ({ name }) => ({ value: name === "ct0" ? "fixture-csrf" : "u%3D990000" }), onChanged: { addListener: () => {} } },
    alarms: { create: async () => {}, onAlarm: { addListener: () => {} } },
    tabs: { get: async () => ({ id: 1, url: tabUrl }), query: async () => [], create: async () => {}, onRemoved: { addListener: () => {} }, sendMessage: async (id, message) => message.type === "GET_VIEWER" ? { account: "viewer" } : undefined }
  };
  const rpc = (type, payload = {}, sender = web) => new Promise((resolve, reject) => receive({ type, ...payload }, sender, answer => answer.ok ? resolve(answer.data) : reject(new Error(answer.error))));
  globalThis.fetch = async (url, options) => {
    if (url.startsWith("https://x.com/")) { blockCalls++; throw new Error("No real block should be submitted in this fixture"); }
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    jevCalls++;
    if (serviceFailure) return new Response("Unavailable", { status: 503 });
    const body = JSON.parse(options.body);
    assert.equal(JSON.stringify(body).includes("900001"), false);
    return Response.json({ answers: { stance: { type: "choice", choice: modelChoice, confidence: .99, probabilities: { spam: modelChoice === "spam" ? .97 : .01, useful: .01, normal: modelChoice === "normal" ? .97 : .01, uncertain: .01 } } } });
  };
  const observation = (index, userId = "900001", extra = {}) => {
    const rootId = index === 1 ? "100000" : "200000", id = String(100000 + index);
    return { account: "viewer", root: { id: rootId, conversationId: rootId, text: "具体的原帖内容", handle: "author", userId: "800001" }, reply: { id, parentId: rootId, conversationId: rootId, text: `模板回复 ${index}`, handle: `user${userId}`, userId, blueVerified: true, following: false, followingAccount: "viewer", followingAt: Date.now(), ...extra }, ancestors: [] };
  };
  try {
    await import("../src/background.js");
    const one = observation(1);
    await Promise.all([rpc("OBSERVE_REPLY", one), rpc("OBSERVE_REPLY", one)]);
    assert.equal(jevCalls, 1, "duplicate page messages share one paid analysis");
    await rpc("OBSERVE_REPLY", observation(2));
    assert.equal(data.state.jobs.length, 0);
    const result = await rpc("OBSERVE_REPLY", observation(3));
    assert.equal(result.status, "pending"); assert.equal(result.action, "block");
    assert.equal(data.state.jobs.length, 1); assert.equal(data.state.jobs[0].module, "observer");
    assert.equal(data.state.sessions[1], undefined, "passive observer does not create a manual original-post task");
    const snapshot = await rpc("SNAPSHOT", {}, ui);
    assert.equal(snapshot.observer.accounts[0].hits, 3); assert.equal(snapshot.observer.dailyUsed, 3);
    assert.equal(JSON.stringify(snapshot.observer).includes("avatar"), false);
    await rpc("CANCEL_JOB", { id: result.historyId }, ui);
    await rpc("OBSERVE_REPLY", observation(4));
    assert.equal(data.state.jobs.filter(j => j.status === "pending").length, 0, "cancelled evidence must not immediately re-block");
    await rpc("OBSERVE_REPLY", observation(5, "900005", { blueVerified: false }));
    assert.equal(jevCalls, 4, "blue-only scope skips unverified accounts");
    await rpc("DEBUG_DRY_RUN", { enabled: true });
    for (const n of [11, 12, 13]) {
      const input = observation(n, "900002"); input.root.id = n === 11 ? "300000" : "400000"; input.root.conversationId = input.root.id; input.reply.parentId = input.root.id; input.reply.conversationId = input.root.id;
      const result = await rpc("OBSERVE_REPLY", input);
      if (n === 13) assert.equal(result.status, "simulated");
    }
    await rpc("DEBUG_DRY_RUN", { enabled: false });
    await rpc("OBSERVE_REPLY", observation(14, "900002"));
    assert.equal(data.state.jobs.filter(j => j.status === "pending").length, 0, "simulated evidence never becomes a real block after leaving debug");
    await t.test("forgetting a simulated account removes the old trigger before a normal new reply", async () => {
      await rpc("DEBUG_DRY_RUN", { enabled: true });
      const prior = await rpc("OBSERVER_DECISIONS", { account: "viewer", replyIds: ["100011", "100012", "100013"] });
      assert.equal(prior.some(result => result.status === "simulated"), true, "stored evidence restores preview eligibility");
      await rpc("OBSERVER_FORGET", { account: "viewer", userId: "900002" }, ui);
      modelChoice = "normal";
      const next = await rpc("OBSERVE_REPLY", observation(15, "900002"));
      assert.equal(next.label, "normal"); assert.equal(next.status, "observing"); assert.equal(next.action, "keep");
      assert.equal((await rpc("OBSERVER_DECISIONS", { account: "viewer", replyIds: ["100011", "100012", "100013"] })).length, 0);
      modelChoice = "spam";
      await rpc("DEBUG_DRY_RUN", { enabled: false });
    });

    const { change } = await import("../src/lib/store.js");
    // Seed durable queue state only; transitions are exercised through the actual worker RPCs.
    const seedObserverJob = async (suffix, reason = "observer") => {
      const userId = `91000${suffix}`, historyId = `observer-history-${suffix}`, jobId = `observer-job-${suffix}`;
      const target = { userId, handle: `account${suffix}`, name: `Example ${suffix}`, following: false, followingAccount: "viewer", followingAt: Date.now() };
      const root = { id: `61000${suffix}`, conversationId: `61000${suffix}`, handle: "author", userId: "800001", text: "观察来源原帖" };
      await change(db => {
        db.history.push({ id: historyId, account: "viewer", module: "observer", observerOwner: true, stanceOwner: false, target, root, reason, sessionId: `observer:viewer:${userId}`, status: "pending", owned: false, created: Date.now(), updated: Date.now() });
        db.jobs.push({ id: jobId, historyId, account: "viewer", kind: "block", module: "observer", target, rootId: root.id, sessionId: `observer:viewer:${userId}`, status: "pending", submitted: false, created: Date.now() });
      });
      return { historyId, jobId, target, root };
    };
    const attachStanceOwner = async fixture => {
      const root = { ...fixture.root, id: `7${fixture.root.id.slice(1)}`, conversationId: `7${fixture.root.id.slice(1)}`, text: "不同的附和任务原帖" };
      tabUrl = `https://x.com/author/status/${root.id}`;
      const session = await rpc("ARM", { account: "viewer", root });
      const reply = { ...fixture.target, id: `8${root.id.slice(1)}`, text: "这条评论命中了附和规则", parentId: root.id, conversationId: root.id };
      const record = await rpc("MANUAL_BLOCK", { account: "viewer", root, reply });
      assert.equal(record.id, fixture.historyId, "a shared account has one durable block operation");
      return { root, session };
    };
    const history = fixture => data.state.history.find(h => h.id === fixture.historyId);
    const job = fixture => data.state.jobs.find(j => j.id === fixture.jobId);

    await t.test("observer-first records transfer to the actual stance root, and undoing either owner preserves the other", async () => {
      const first = await seedObserverJob("1"), { root, session } = await attachStanceOwner(first);
      assert.equal(history(first).module, "stance"); assert.equal(history(first).root.id, root.id); assert.equal(history(first).sessionId, session.id);
      assert.equal(job(first).module, "stance"); assert.equal(job(first).rootId, root.id);
      await rpc("UNDO_TASK", { account: "viewer", rootId: root.id }, ui);
      assert.equal(history(first).module, "observer"); assert.equal(history(first).stanceOwner, false);
      assert.equal(job(first).module, "observer"); assert.equal(job(first).status, "pending", "withdrawing the stance task preserves the observer job");
      await rpc("UNDO", { id: first.historyId, module: "observer" }, ui);
      assert.equal(job(first).status, "cancelled", "withdrawing the remaining owner cancels the unsent operation");

      const second = await seedObserverJob("2"), attached = await attachStanceOwner(second);
      await rpc("UNDO", { id: second.historyId, module: "observer" }, ui);
      assert.equal(history(second).observerOwner, false); assert.equal(history(second).stanceOwner, true);
      assert.equal(job(second).status, "pending"); assert.equal(history(second).root.id, attached.root.id);
      await rpc("UNDO_TASK", { account: "viewer", rootId: attached.root.id }, ui);
      assert.equal(job(second).status, "cancelled", "the remaining stance root still owns a reversible task");
    });

    await t.test("stopping an automatic stance session transfers a shared job to its observer owner", async () => {
      const fixture = await seedObserverJob("3"); await attachStanceOwner(fixture);
      await change(db => { db.jobs.find(j => j.id === fixture.jobId).manual = false; });
      await rpc("STOP_SESSION", {});
      assert.equal(history(fixture).stanceOwner, false); assert.equal(history(fixture).observerOwner, true);
      assert.equal(job(fixture).module, "observer"); assert.equal(job(fixture).status, "pending");
      await rpc("UNDO", { id: fixture.historyId, module: "observer" }, ui);
      assert.equal(job(fixture).status, "cancelled");
    });

    await t.test("a manual click retains its authorization after stopping the session and disabling observation", async () => {
      const fixture = await seedObserverJob("5"), { root } = await attachStanceOwner(fixture);
      assert.equal(job(fixture).manual, true);
      await rpc("STOP_SESSION", {});
      assert.equal(history(fixture).stanceOwner, true);
      await rpc("SAVE_SETTINGS", { value: { observer: { enabled: false } } }, ui);
      assert.equal(job(fixture).module, "stance"); assert.equal(job(fixture).status, "pending");
      assert.equal(history(fixture).observerOwner, false);
      await rpc("UNDO_TASK", { account: "viewer", rootId: root.id }, ui);
      assert.equal(job(fixture).status, "cancelled");
      await rpc("SAVE_SETTINGS", { value: { observer: { enabled: true } } }, ui);
    });

    await t.test("policy changes revoke obsolete observer jobs but preserve shared and submitted operations", async () => {
      const baseline = structuredClone(data.state.settings.observer);
      let index = 10;
      for (const policy of [{ scope: "all" }, { threshold: .99 }, { confidence: .99 }, { minHits: 4 }, { minThreads: 3 }, { hitRate: 1 }, { retentionDays: 7 }, { skipFollowing: false }]) {
        await rpc("SAVE_SETTINGS", { value: { observer: baseline } }, ui);
        const fixture = await seedObserverJob(String(index++));
        await rpc("SAVE_SETTINGS", { value: { observer: policy } }, ui);
        assert.equal(job(fixture).status, "cancelled", JSON.stringify(policy));
      }
      await rpc("SAVE_SETTINGS", { value: { observer: baseline } }, ui);
      const unsent = await seedObserverJob("30"), sent = await seedObserverJob("31"), shared = await seedObserverJob("32");
      await attachStanceOwner(shared);
      await change(db => {
        db.jobs.find(j => j.id === unsent.jobId).status = "running";
        Object.assign(db.jobs.find(j => j.id === sent.jobId), { status: "running", submitted: true });
      });
      await rpc("SAVE_SETTINGS", { value: { observer: { showMarkers: true, dailyLimit: 250 } } }, ui);
      assert.equal(job(unsent).status, "running", "display and budget settings preserve existing authorization");
      const editor = await rpc("RULE_CONFIG", { module: "observer" }, ui);
      editor.rule.prompt += " 新的判定标准。";
      await rpc("SAVE_RULE_CONFIG", { module: "observer", rule: editor.rule, revision: editor.revision }, ui);
      assert.equal(job(unsent).status, "cancelled");
      assert.equal(job(sent).status, "running", "sent requests cannot be recalled");
      assert.equal(job(shared).status, "pending"); assert.equal(history(shared).observerOwner, false);
      await change(db => { db.jobs.find(j => j.id === sent.jobId).status = "done"; });
      await rpc("SAVE_SETTINGS", { value: { observer: baseline } }, ui);
    });

    await t.test("observer history exposes ownership and failures, and failed blocks can be retried explicitly", async () => {
      const failed = await seedObserverJob("40"), preexisting = await seedObserverJob("41");
      await change(db => {
        Object.assign(db.jobs.find(j => j.id === failed.jobId), { status: "failed", submitted: true });
        Object.assign(db.history.find(h => h.id === failed.historyId), { status: "failed", error: "fixture HTTP failure" });
        Object.assign(db.jobs.find(j => j.id === preexisting.jobId), { status: "done" });
        Object.assign(db.history.find(h => h.id === preexisting.historyId), { status: "preexisting", owned: false });
      });
      const snapshot = await rpc("SNAPSHOT", {}, ui);
      assert.equal(snapshot.observer.accounts.find(row => row.historyId === failed.historyId).error, "fixture HTTP failure");
      assert.equal(snapshot.observer.accounts.find(row => row.historyId === preexisting.historyId).owned, false);
      await rpc("RETRY_JOB", { id: failed.historyId }, ui);
      assert.equal(job(failed).status, "pending"); assert.equal(job(failed).submitted, false);
      assert.equal(history(failed).status, "pending");
      await rpc("SAVE_SETTINGS", { value: { observer: { threshold: .99 } } }, ui);
      assert.equal(job(failed).status, "cancelled");
      await assert.rejects(rpc("RETRY_JOB", { id: failed.historyId }, ui));
      await rpc("SAVE_SETTINGS", { value: { observer: { preset: "careful" } } }, ui);
    });

    await t.test("an author record transferred to observer ownership loses the author following exemption", async () => {
      const fixture = await seedObserverJob("4", "author");
      await rpc("OBSERVER_RELATIONSHIPS", { account: "viewer", posts: [{ ...fixture.target, id: "810004", following: true, followingAt: Date.now() + 1 }] });
      assert.equal(job(fixture).status, "cancelled"); assert.equal(history(fixture).status, "cancelled");
    });
    await t.test("transient model failures remain retryable after resuming the service", async () => {
      const input = observation(29, "900029");
      serviceFailure = true;
      assert.equal((await rpc("OBSERVE_REPLY", input)).why, "analysis-error");
      assert.ok(data.state.modelError);
      serviceFailure = false;
      await rpc("RESUME_SERVICES", {}, ui);
      const result = await rpc("OBSERVE_REPLY", input);
      assert.equal(result.label, "spam");
      assert.equal(result.status, "observing");
    });
    assert.equal(blockCalls, 0);
    await rpc("SAVE_SETTINGS", { value: { observer: { enabled: false } } }, ui);
    assert.equal((await rpc("OBSERVE_REPLY", observation(20))).action, "skip");
  } finally { globalThis.fetch = originalFetch; }
});
