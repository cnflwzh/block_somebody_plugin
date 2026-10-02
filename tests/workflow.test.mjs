import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/lib/core.js";

// Exercise the real worker and persistent queue with local Chrome/X/Jev substitutes.
// No browser UI, outbound network, login credentials or account mutations are involved.
test("worker flow: arm, whitelist, classify, background queue and undo", async t => {
  let receive, alarm, removed, actionMode = "normal", badAnswer = false, remoteBlocked = false, sentJev = 0, submitted = 0, tabsClosed = false, cookieActor = "990000";
  let now = Date.now();
  const originalNow = Date.now, originalFetch = globalThis.fetch;
  Date.now = () => now;
  const data = { jevKey: "local-fixture-key", state: { version: 1, settings: { ...DEFAULTS }, whitelist: [], history: [], jobs: [], sessions: {}, nextActionAt: 0, queueError: "", modelError: "" } };
  const origin = "chrome-extension://fixture/";
  // X keeps the same content script while routing from Home into a tweet.
  const sender = { id: "fixture", url: "https://x.com/home", tab: { id: 1 } };
  let tabUrl = "https://x.com/author/status/100000";
  const ui = { id: "fixture", url: `${origin}src/manager/manager.html` };
  const rpc = (type, payload = {}, source = sender) => new Promise((resolve, reject) => receive({ type, ...payload }, source, r => r.ok ? resolve(r.data) : reject(new Error(r.error))));
  globalThis.chrome = {
    storage: { local: { setAccessLevel: async () => {}, get: async k => ({ [k]: structuredClone(data[k]) }), set: async value => Object.assign(data, structuredClone(value)) } },
    runtime: { id: "fixture", getURL: path => origin + path, onMessage: { addListener: fn => { receive = fn; } }, sendMessage: async () => {} },
    action: { onClicked: { addListener: () => {} } },
    cookies: { get: async ({ name }) => ({ value: name === "ct0" ? "fixture-csrf" : `u%3D${cookieActor}` }), onChanged: { addListener: () => {} } },
    alarms: { create: async () => {}, onAlarm: { addListener: fn => { alarm = fn; } } },
    tabs: { get: async () => ({ id: 1, url: tabUrl }), query: async () => tabsClosed ? [] : [{ id: 1, url: tabUrl }], create: async () => {}, onRemoved: { addListener: fn => { removed = fn; } },
      sendMessage: async (tabId, m) => {
        if (m.type === "GET_VIEWER") return { account: "viewer" };
        if (m.type === "INSPECT_TARGET") return { ok: true, target: { ...m.target, blocking: remoteBlocked } };
        if (m.type !== "EXECUTE_ACTION") return;
        const job = m.job;
        assert.equal(job.kind, "unblock", "block jobs must never depend on a page adapter");
        if (!await rpc("ACTION_ALLOWED", { jobId: job.id })) return { ok: false, cancelled: true };
        const baseline = { ...job.target, userId: job.target.userId || "900001", blocking: false };
        if (!await rpc("ACTION_SUBMIT", { jobId: job.id, baseline })) return { ok: false, cancelled: true };
        assert.equal(await rpc("ACTION_SUBMIT", { jobId: job.id, baseline }), false, "same job cannot be submitted twice");
        submitted++; remoteBlocked = job.kind === "block";
        return actionMode === "uncertain" ? { ok: false, uncertain: true, error: "fixture lost response" } : { ok: true, target: baseline };
      } }
  };
  globalThis.fetch = async (url, options) => {
    if (url === "https://x.com/i/api/1.1/blocks/create.json") {
      assert.equal(options.method, "POST");
      assert.equal(data.state.jobs.some(j => j.kind === "block" && j.status === "running" && j.submitted), true);
      submitted++;
      if (actionMode === "404") return { ok: false, status: 404, headers: new Headers(), json: async () => ({ errors: [{ code: 34 }] }) };
      remoteBlocked = true;
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) };
    }
    assert.equal(url, "https://api.typesafe.ai/v1/systemone"); sentJev++;
    assert.equal(JSON.stringify(JSON.parse(options.body)).includes("900001"), false);
    if (badAnswer) return Response.json({ answers: { stance: { type: "choice", choice: "support", probabilities: { support: .2, oppose: .7, neutral: .05, uncertain: .05 }, confidence: .98 } } });
    return Response.json({ answers: { stance: { type: "choice", choice: "support", probabilities: { support: .96, oppose: .01, neutral: .01, uncertain: .02 }, confidence: .98 } } });
  };
  const flush = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 2)); } assert.fail("Worker did not reach expected state"); };
  try {
    await import("../src/background.js");
    const root = { id: "100000", conversationId: "100000", parentId: "", handle: "author", userId: "900000", text: "原帖观点" };
    const reply = { id: "100001", conversationId: "100000", parentId: "100000", handle: "supporter", userId: "900001", text: "明确支持原帖" };
    let session;
    await t.test("explicit activation queues the author once", async () => {
      session = await rpc("ARM", { root, account: "viewer" });
      assert.equal(data.state.jobs.length, 0);
      const waiting = await rpc("LOCATION", { root, account: "viewer", postId: root.id });
      assert.equal(waiting.onThread, true, "waiting for sorting is not leaving the thread");
      assert.equal(waiting.active, false);
      assert.equal(data.state.jobs.length, 0, "relevance or unloaded first page must not queue the author");
      await rpc("LOCATION", { root, account: "viewer", postId: root.id, pageReady: true });
      assert.equal(data.state.jobs.length, 0, "readiness cannot bypass the selected-sort confirmation");
      await rpc("LOCATION", { root, account: "viewer", postId: root.id, sort: "recent" });
      assert.equal(data.state.jobs.length, 0, "selected recent sort alone is insufficient");
      await rpc("LOCATION", { root, account: "viewer", postId: root.id, pageReady: true, sort: "recent" });
      await flush(() => data.state.history[0]?.status === "submitted");
      assert.equal(submitted, 1);
      await rpc("LOCATION", { root, account: "viewer", postId: root.id, pageReady: true, sort: "recent" });
      assert.equal(data.state.history.length, 1);
      assert.equal(data.state.sessions[1].autoLoad, false);
      await rpc("AUTO_LOAD", { sessionId: session.id, account: "viewer", enabled: true });
      assert.equal(data.state.sessions[1].autoLoad, true);
      await assert.rejects(rpc("AUTO_LOAD", { sessionId: "old-session", account: "viewer", enabled: false }));
      assert.equal(data.state.sessions[1].autoLoad, true);
      await rpc("AUTO_LOAD", { sessionId: session.id, account: "viewer", enabled: false });
    });
    await t.test("sorting readiness and stale task notifications preserve current task identity", async () => {
      const location = { sessionId: session.id, root, account: "viewer", postId: root.id, sort: "recent" };
      const waiting = await rpc("LOCATION", { ...location, pageReady: false });
      assert.equal(waiting.onThread, true); assert.equal(waiting.active, false);
      const active = await rpc("LOCATION", { ...location, pageReady: true });
      assert.equal(active.active, true); assert.equal(active.sessionId, session.id);
      assert.equal(await rpc("LOCATION", { ...location, sessionId: "old-session", postId: "" }), null);
      assert.equal(data.state.sessions[1].active, true);
      assert.equal(submitted, 1, "resynchronizing must not enqueue the author again");
    });
    await t.test("live tab route rejects stale detail messages after real navigation and permits return", async () => {
      const location = { sessionId: session.id, root, account: "viewer", postId: root.id, pageReady: true, sort: "recent" };
      const before = sentJev;
      sender.url = tabUrl; tabUrl = "https://x.com/home";
      await assert.rejects(rpc("CLASSIFY", { sessionId: session.id, account: "viewer", reply, ancestors: [] }));
      await assert.rejects(rpc("AUTO_LOAD", { sessionId: session.id, account: "viewer", enabled: true }));
      await assert.rejects(rpc("MANUAL_BLOCK", { root, reply, account: "viewer" }));
      assert.equal(sentJev, before);
      const left = await rpc("LOCATION", location);
      assert.equal(left.onThread, false); assert.equal(left.active, false); assert.equal(left.pageReady, false);
      tabUrl = sender.url; sender.url = "https://x.com/home";
      assert.equal((await rpc("LOCATION", location)).active, true);
    });
    await t.test("invalid probability result affects one reply without stopping the task or repeating charges", async () => {
      const invalidReply = { ...reply, id: "100099", userId: "900099", handle: "invalid", text: "异常结果样本" };
      const beforeJobs = data.state.jobs.length, beforeCalls = sentJev;
      badAnswer = true;
      const result = await rpc("CLASSIFY", { sessionId: session.id, account: "viewer", reply: invalidReply, ancestors: [] });
      badAnswer = false;
      assert.equal(result.action, "keep"); assert.equal(result.support, null); assert.match(result.error, /最高概率/);
      assert.equal(data.state.modelError, ""); assert.equal(data.state.jobs.length, beforeJobs);
      assert.equal((await rpc("CLASSIFY", { sessionId: session.id, account: "viewer", reply: invalidReply, ancestors: [] })).error, result.error);
      assert.equal(sentJev, beforeCalls + 1);
    });
    await t.test("whitelisted reply is never sent to Jev", async () => {
      const beforeCalls = sentJev;
      await rpc("WHITELIST_ADD", { handle: reply.handle });
      assert.equal((await rpc("CLASSIFY", { sessionId: session.id, account: "viewer", reply, ancestors: [] })).action, "skip");
      assert.equal(sentJev, beforeCalls);
      await rpc("WHITELIST_REMOVE", { handle: reply.handle }, ui);
    });
    await t.test("support classification is cached and deduplicated", async () => {
      const beforeCalls = sentJev;
      now += 5000;
      const message = { sessionId: session.id, account: "viewer", reply, ancestors: [] };
      const result = await rpc("CLASSIFY", message);
      assert.equal(result.action, "block");
      await flush(() => data.state.history.find(h => h.target.handle === reply.handle)?.status === "submitted");
      await rpc("CLASSIFY", message);
      assert.equal(sentJev, beforeCalls + 1); assert.equal(submitted, 2);
    });
    await t.test("undo retains history and excludes user from current session", async () => {
      now += 5000;
      const h = data.state.history.find(h => h.target.handle === reply.handle);
      await rpc("UNDO", { id: h.id, whitelist: true }, ui);
      await flush(() => data.state.history.find(x => x.id === h.id)?.status === "unblocked");
      assert.equal(data.state.sessions[1].excluded.includes(reply.handle), true);
      assert.equal(data.state.whitelist.some(w => w.handle === reply.handle), true);
    });
    await t.test("HTTP failure is recorded without pausing other jobs or automatically retrying", async () => {
      now += 5000; actionMode = "404";
      const next = { ...reply, id: "100002", handle: "second", userId: "900002" };
      await rpc("CLASSIFY", { sessionId: session.id, account: "viewer", reply: next, ancestors: [] });
      await flush(() => data.state.history.find(h => h.target.handle === next.handle)?.status === "failed");
      const h = data.state.history.find(h => h.target.handle === next.handle), before = submitted;
      now += 60000; alarm({ name: "blocksb-queue" });
      await new Promise(r => setTimeout(r, 10)); assert.equal(submitted, before);
      assert.equal(data.state.queueError, "");
      assert.match(h.error, /404/); actionMode = "normal";
      await rpc("RETRY_JOB", { id: h.id }, ui);
      await flush(() => data.state.history.find(x => x.id === h.id).status === "submitted");
      assert.equal(data.state.history.find(x => x.id === h.id).owned, true);
    });
    await t.test("account mismatch and sibling replies never reach Jev", async () => {
      const before = sentJev;
      await assert.rejects(rpc("CLASSIFY", { sessionId: session.id, account: "other", reply, ancestors: [] }));
      assert.equal((await rpc("CLASSIFY", { sessionId: session.id, account: "viewer", reply: { ...reply, id: "100005", handle: "sibling", parentId: "999999" }, ancestors: [] })).action, "skip");
      assert.equal(sentJev, before);
    });
    await t.test("exports do not include credentials or queued execution grants", async () => {
      const output = await rpc("EXPORT", {}, ui);
      assert.equal(JSON.stringify(output).includes(data.jevKey), false);
      assert.equal("jobs" in output, false);
      assert.equal(JSON.stringify(output).includes("fixture-csrf"), false);
    });
    await t.test("queued blocks survive navigation and tab closure, retain spacing, and wait for the right account", async () => {
      const first = { ...reply, id: "100006", userId: "900006", handle: "queuedone" };
      const second = { ...reply, id: "100007", userId: "900007", handle: "queuedtwo" };
      await rpc("MANUAL_BLOCK", { root, reply: first, account: "viewer" });
      await rpc("MANUAL_BLOCK", { root, reply: second, account: "viewer" });
      assert.equal(data.state.jobs.filter(j => j.status === "pending").length, 2);
      tabUrl = "https://x.com/home";
      await rpc("LOCATION", { account: "viewer", postId: "" });
      removed(1); tabsClosed = true;
      await flush(() => !data.state.sessions[1]);
      const before = submitted;
      cookieActor = "880000"; now += 3000; alarm({ name: "blocksb-queue" });
      await flush(() => !!data.state.queueNotice); assert.equal(submitted, before);
      cookieActor = "990000"; alarm({ name: "blocksb-queue" });
      await flush(() => data.state.history.find(h => h.target.handle === first.handle)?.status === "submitted");
      assert.equal(submitted, before + 1);
      now += 2499; alarm({ name: "blocksb-queue" });
      await new Promise(r => setTimeout(r, 10)); assert.equal(submitted, before + 1);
      now++; alarm({ name: "blocksb-queue" });
      await flush(() => data.state.history.find(h => h.target.handle === second.handle)?.status === "submitted");
      assert.equal(submitted, before + 2);
    });
  } finally { Date.now = originalNow; globalThis.fetch = originalFetch; }
});
