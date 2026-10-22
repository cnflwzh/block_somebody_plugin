import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseReplyTimeline, completeReplyContexts, fetchReplyTimeline } from "../src/lib/x-replies.js";
import { reserveReplyCollection, finishReplyCollection, readReplyCollections, reserveReplyPage, pauseReplyPages, forgetObserverUser } from "../src/lib/observer-store.js";

const now = Date.now();
function tweet(id, author, parent = "", root = id) {
  return { __typename: "Tweet", rest_id: id, core: { user_results: { result: { rest_id: author, core: { screen_name: `u${author}`, name: "Fixture" }, is_blue_verified: true, relationship_perspectives: { following: false }, avatar: { image_url: "never retained" } } } },
    legacy: { full_text: "Synthetic contextual text", conversation_id_str: root, in_reply_to_status_id_str: parent, created_at: new Date(now).toUTCString() } };
}
const wrap = items => ({ data: { user: { result: { timeline_v2: { timeline: { instructions: [{ entries: items }] } } } } } });
test("recent reply parsing verifies full chains and rejects quotes, promotions, missing roots and cycles", () => {
  const root = tweet("100000", "800000"), parent = tweet("100001", "700000", root.rest_id, root.rest_id);
  const good = tweet("100002", "900000", parent.rest_id, root.rest_id);
  const quoted = tweet("100003", "900000", root.rest_id, root.rest_id); root.quoted_status_result = { result: quoted };
  const missing = tweet("100004", "900000", "200000", "200000");
  const cycle = tweet("100005", "900000", "100005", root.rest_id);
  const promoted = { promotedMetadata: {}, itemContent: { tweet_results: { result: tweet("100006", "900000", root.rest_id, root.rest_id) } } };
  const parsed = parseReplyTimeline(wrap([root, parent, good, missing, cycle, promoted, { cursorType: "Bottom", value: "page-two" }]), "viewer", now);
  assert.equal(parsed.cursor, "page-two");
  assert.equal(parsed.posts.has(quoted.rest_id), false);
  assert.equal(parsed.posts.has("100006"), false);
  assert.equal(JSON.stringify([...parsed.posts.values()]).includes("avatar"), false);
  const result = completeReplyContexts(parsed.posts, "900000", 30, now);
  assert.deepEqual(result.map(c => c.reply.id), [good.rest_id]);
  assert.equal(result[0].ancestors[0].id, parent.rest_id);
  assert.equal(result[0].reply.following, false);
});
test("old, truncated and self-thread replies do not become account evidence", () => {
  const root = tweet("300000", "900001"), reply = tweet("300001", "900001", root.rest_id, root.rest_id);
  assert.equal(completeReplyContexts(parseReplyTimeline(wrap([root, reply]), "viewer").posts, "900001", 30).length, 0);
  root.core.user_results.result.rest_id = "800001";
  reply.legacy.created_at = new Date(now - 31 * 86400000).toUTCString();
  assert.equal(completeReplyContexts(parseReplyTimeline(wrap([root, reply]), "viewer").posts, "900001", 30).length, 0);
  reply.legacy.created_at = new Date(now).toUTCString(); reply.legacy.truncated = true;
  assert.equal(completeReplyContexts(parseReplyTimeline(wrap([root, reply]), "viewer").posts, "900001", 30).length, 0);
});
test("collection cooldown and network budgets persist, are atomic and honor withdrawal", async () => {
  assert.deepEqual(await Promise.all([reserveReplyCollection("fixture:900002", 0, now), reserveReplyCollection("fixture:900002", 0, now)]), [true, false]);
  await forgetObserverUser("fixture", "900002");
  await finishReplyCollection("fixture:900002", 0, "ready");
  assert.equal((await readReplyCollections()).get("fixture:900002").status, "fetching", "late completion must not override withdrawal");
  assert.equal(await reserveReplyCollection("fixture:900002", 0, now + 7200000), false);
  assert.equal((await reserveReplyPage("login-fixture", now)).allowed, true);
  assert.equal((await reserveReplyPage("login-fixture", now + 1)).allowed, false);
  await pauseReplyPages("login-fixture", now + 100000);
  assert.equal((await reserveReplyPage("login-fixture", now + 5000)).retryAt, now + 100000);
  assert.equal((await reserveReplyPage("other-login", now + 5000)).allowed, true);
});
test("worker read uses only the bound X origin and rejects account changes and HTTP failures", async () => {
  const oldFetch = globalThis.fetch, oldChrome = globalThis.chrome;
  let actor = "990000", calls = 0, fail = false, switchAfter = false;
  globalThis.chrome = { cookies: { get: async ({ name }) => ({ value: name === "ct0" ? "synthetic-csrf" : `u=${actor}` }) } };
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(new URL(url).origin, "https://x.com"); assert.equal(options.credentials, "include"); assert.equal(options.redirect, "error");
    assert.equal(JSON.parse(new URL(url).searchParams.get("variables")).userId, "900000");
    if (fail) return new Response("limited", { status: 429, headers: { "retry-after": "120" } });
    if (switchAfter) actor = "990001";
    return Response.json(wrap([]));
  };
  try {
    await fetchReplyTimeline({ origin: "https://x.com", actorId: "990000" }, "900000", "", new AbortController().signal);
    assert.equal(calls, 1);
    fail = true;
    await assert.rejects(fetchReplyTimeline({ origin: "https://x.com", actorId: "990000" }, "900000", "", new AbortController().signal), e => e.status === 429 && e.retryAt >= Date.now() + 119000);
    fail = false; switchAfter = true;
    await assert.rejects(fetchReplyTimeline({ origin: "https://x.com", actorId: "990000" }, "900000", "", new AbortController().signal), e => e.code === "REPLIES_CANCELLED");
    await assert.rejects(fetchReplyTimeline({ origin: "https://other.example", actorId: actor }, "900000", "", new AbortController().signal));
    assert.equal(calls, 3);
  } finally { globalThis.fetch = oldFetch; globalThis.chrome = oldChrome; }
});
