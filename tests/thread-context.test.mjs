import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { syncThreadContext, mergeContextPost } from "../src/lib/thread-context.js";

const post = { id: "100001", handle: "reader", userId: "900001", text: "完整的父评论", parentId: "100000", conversationId: "100000", incomplete: false, hasMedia: false };

test("missing DOM subscription metadata preserves explicit API evidence", () => {
  assert.equal(mergeContextPost({ ...post, blueVerified: true }, { ...post, blueVerified: null }).blueVerified, true);
  assert.equal(mergeContextPost({ ...post, blueVerified: true }, { ...post, blueVerified: false }).blueVerified, false);
});

test("saved parent context survives tombstones and stays scoped to account and task", async () => {
  await syncThreadContext("viewer", "100000", [post], []);
  await syncThreadContext("viewer", "100000", [{ ...post, text: "", incomplete: true }], []);
  const restored = await syncThreadContext("viewer", "100000", [], [post.id]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].text, post.text);
  assert.equal(restored[0].incomplete, false);
  assert.deepEqual(await syncThreadContext("other", "100000", [], [post.id]), []);
  assert.deepEqual(await syncThreadContext("viewer", "200000", [], [post.id]), []);
});

test("context older than 30 days is not restored", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    await syncThreadContext("expiry", "100000", [post], []);
    now += 30 * 86400000 + 1;
    assert.deepEqual(await syncThreadContext("expiry", "100000", [], [post.id]), []);
  } finally { Date.now = originalNow; }
});
