import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { askJev } from "../src/lib/jev.js";
import { askJevCached, requestKey } from "../src/lib/jev-cache.js";
import { DEFAULTS, DEFAULT_ENDPOINT, buildRequest, parseDecision, updateSettings } from "../src/lib/core.js";

const root = { id: "100000", text: "约定应当守时。" };
const reply = { id: "100001", parentId: root.id, text: "我同意。" };
const request = buildRequest(root, reply, null, DEFAULTS.model);
const answer = () => ({ model: DEFAULTS.model, answers: { stance: { type: "choice", choice: "support", confidence: .98,
  probabilities: { support: .97, oppose: .01, neutral: .01, uncertain: .01 }, diagnostic: "must not be cached" } }, echo: "must not be cached" });
const validate = value => parseDecision(value, DEFAULTS, root, reply);

// Exercise real request/cancellation code with local ReadableStreams, never outbound HTTP.
test("Jev transport, cache identity and concurrent consumers", async t => {
  const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome;
  let calls = 0;
  globalThis.chrome = { permissions: { contains: async () => false } };
  try {
    await t.test("custom endpoints require permission before sending and config keys are isolated", async () => {
      globalThis.fetch = async () => { calls++; return Response.json(answer()); };
      await assert.rejects(askJev(request, "fixture-only-key", undefined, "https://model.example/api"), /未授权/);
      assert.equal(calls, 0);
      const first = await requestKey(request);
      assert.equal(first, await requestKey({ questions: request.questions, state: request.state, model: request.model }));
      assert.notEqual(first, await requestKey(request, "https://model.example/api"));
      assert.notEqual(first, await requestKey(buildRequest(root, reply, null, DEFAULTS.model, "新的判断规则")));
      for (const endpoint of ["http://model.example/api", "https://u:p@model.example/api", "https://model.example/api?key=test", "https://model.example/api#fragment"]) {
        assert.throws(() => updateSettings(DEFAULTS, { endpoint }));
      }
    });
    await t.test("request omits cookies and disallows redirects", async () => {
      globalThis.fetch = async (url, options) => {
        assert.equal(url, DEFAULT_ENDPOINT);
        assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
        assert.equal(options.headers.Authorization, "Bearer fixture-only-key");
        return Response.json(answer());
      };
      assert.equal(validate(await askJev(request, "fixture-only-key")).action, "block");
    });
    await t.test("empty, malformed and oversized chunked responses cannot authorize actions", async () => {
      for (const response of [new Response(null, { status: 204 }), new Response("not json"), new Response("{}", { headers: { "content-length": "300000" } })]) {
        globalThis.fetch = async () => response;
        await assert.rejects(askJev(request, "fixture-only-key"), { code: "JEV_INVALID_ANSWER" });
      }
      let cancelled = false;
      globalThis.fetch = async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(65536)); },
        cancel() { cancelled = true; }
      }));
      await assert.rejects(askJev(request, "fixture-only-key"), { code: "JEV_INVALID_ANSWER" });
      assert.equal(cancelled, true);
    });
    await t.test("one cancelled consumer does not abort another; response fields stay compact", async () => {
      let release, wireSignal, started;
      const began = new Promise(resolve => { started = resolve; }); calls = 0;
      globalThis.fetch = async (_, options) => {
        calls++; wireSignal = options.signal; started();
        return new Promise(resolve => { release = () => resolve(Response.json(answer())); });
      };
      const a = new AbortController();
      const first = askJevCached(request, "fixture-only-key", a.signal, validate);
      const firstCancelled = assert.rejects(first, /取消/);
      const second = askJevCached(request, "fixture-only-key", undefined, validate);
      await began;
      // Both digests must finish before cancellation; allow the second consumer to join.
      await new Promise(resolve => setTimeout(resolve, 10));
      a.abort(); await firstCancelled;
      assert.equal(wireSignal.aborted, false);
      release();
      const result = await second;
      assert.equal(calls, 1); assert.equal(result.answers.stance.diagnostic, undefined);
      assert.equal(result.echo, undefined); assert.equal(validate(result).action, "block");
    });
    await t.test("cancelling all consumers aborts the transport; a new request can proceed", async () => {
      // Use a fresh context: the preceding subtest has already persisted its answer.
      const uncachedRequest = buildRequest(root, { ...reply, text: "新的取消测试上下文" }, null, DEFAULTS.model);
      let started, wireSignal;
      const began = new Promise(resolve => { started = resolve; });
      globalThis.fetch = async (_, options) => {
        wireSignal = options.signal; started();
        return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
      };
      const controller = new AbortController();
      const pending = askJevCached(uncachedRequest, "fixture-only-key", controller.signal, validate);
      const cancelled = assert.rejects(pending, /取消/);
      await began; controller.abort(); await cancelled;
      assert.equal(wireSignal.aborted, true);
      globalThis.fetch = async () => Response.json(answer());
      assert.equal(validate(await askJevCached(uncachedRequest, "fixture-only-key", undefined, validate)).action, "block");
    });
  } finally { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; }
});
