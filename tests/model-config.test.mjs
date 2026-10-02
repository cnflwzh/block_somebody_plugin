import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/lib/core.js";

test("model configuration saves atomically and never restores stale keys/settings", async t => {
  const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome;
  const data = { jevKey: "fixture-original-key", state: { settings: { ...DEFAULTS, paused: true }, sessions: {}, jobs: [], history: [], whitelist: [], nextActionAt: 0, queueError: "", modelError: "" } };
  let receive, calls = 0, holding = false;
  const waiting = [];
  const answer = { answers: { stance: { type: "choice", choice: "support", confidence: .99, probabilities: { support: .97, oppose: .01, neutral: .01, uncertain: .01 } } } };
  globalThis.chrome = {
    storage: { local: { setAccessLevel: async () => {}, get: async k => ({ [k]: structuredClone(data[k]) }), set: async value => Object.assign(data, structuredClone(value)) } },
    runtime: { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, onMessage: { addListener: fn => { receive = fn; } }, sendMessage: async () => {} },
    permissions: { contains: async () => true },
    alarms: { create: async () => {}, onAlarm: { addListener() {} } },
    cookies: { onChanged: { addListener() {} } },
    tabs: { query: async () => [], sendMessage: async () => {}, onRemoved: { addListener() {} } }
  };
  globalThis.fetch = async (_, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.state.reply, "同意，守时是基本礼貌。");
    if (holding) return new Promise(resolve => waiting.push(() => resolve(Response.json(answer))));
    return Response.json(answer);
  };
  const ui = { id: "fixture", url: "chrome-extension://fixture/src/manager/manager.html" };
  const rpc = (type, payload = {}, sender = ui) => new Promise((resolve, reject) => receive({ type, ...payload }, sender, r => r.ok ? resolve(r.data) : reject(Error(r.error))));
  const config = { endpoint: "https://model.example/api", model: "custom/jev", customPrompt: "按回复的主要观点判断立场。" };
  const waitFor = async count => { for (let i = 0; i < 100 && waiting.length < count; i++) await new Promise(r => setTimeout(r, 2)); assert.equal(waiting.length, count); };
  try {
    await import("../src/background.js");
    await t.test("changing origin requires a newly entered key", async () => {
      await assert.rejects(rpc("SAVE_MODEL_CONFIG", { config }), /重新输入/);
      assert.equal(calls, 0); assert.equal(data.jevKey, "fixture-original-key");
      await rpc("SAVE_MODEL_CONFIG", { config, value: "fixture-new-key" });
      assert.equal(data.state.settings.endpoint, config.endpoint);
      assert.equal(data.state.settings.customPrompt, config.customPrompt);
      assert.equal(data.jevKey, "fixture-new-key"); assert.equal(data.state.settings.analysisRevision, 1);
    });
    await t.test("a slow connection check preserves concurrently saved thresholds", async () => {
      holding = true;
      const pending = rpc("SAVE_MODEL_CONFIG", { config: { ...config, model: "custom/jev-next" } });
      await waitFor(1);
      await rpc("SAVE_SETTINGS", { value: { confidence: .89 } });
      waiting.shift()(); await pending;
      assert.equal(data.state.settings.confidence, .89);
      assert.equal(data.state.settings.model, "custom/jev-next");
    });
    await t.test("an older connection response cannot overwrite a newer save", async () => {
      const older = rpc("SAVE_MODEL_CONFIG", { config: { ...config, model: "custom/older" } });
      const rejected = assert.rejects(older, /其他窗口更改/);
      await waitFor(1);
      const newer = rpc("SAVE_MODEL_CONFIG", { config: { ...config, model: "custom/newer" } });
      await waitFor(2);
      waiting.pop()(); await newer; waiting.shift()(); await rejected;
      assert.equal(data.state.settings.model, "custom/newer");
    });
    await t.test("removing the key during a connection check cannot resurrect it", async () => {
      const pending = rpc("SAVE_MODEL_CONFIG", { config });
      const rejected = assert.rejects(pending, /其他窗口更改/);
      await waitFor(1); await rpc("REMOVE_KEY"); waiting.shift()(); await rejected;
      assert.equal(data.jevKey, "");
      const snapshot = await rpc("SNAPSHOT", { account: "viewer" }, { id: "fixture", url: "https://x.com/home", tab: { id: 1 } });
      assert.equal(snapshot.settings.configured, false);
      assert.equal(snapshot.settings.customPrompt, undefined); assert.equal(snapshot.settings.endpoint, undefined);
      assert.equal(snapshot.jevKey, undefined);
    });
  } finally {
    // Let the worker's short notification settle before removing the mocked Chrome API.
    await new Promise(resolve => setTimeout(resolve, 150));
    globalThis.fetch = originalFetch; globalThis.chrome = originalChrome;
  }
});
