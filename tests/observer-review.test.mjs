import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { OBSERVER_DEFAULTS, normalizeObserverSettings } from "../src/lib/observer-core.js";
import { ACCOUNT_REVIEW_VERSION, reviewContext, selectReviewSamples, buildAccountReviewRequest, eligibleAccountReview, reviewPolicyKey } from "../src/lib/observer-review.js";
import { reserveAccountReview, saveObserverEvidence, saveAccountReview, readObserverUser, observerEpoch, clearAccountReviewData, forgetObserverUser } from "../src/lib/observer-store.js";
const now = Date.now(), config = { ...OBSERVER_DEFAULTS, enabled: true, mode: "combined" };
const rows = Array.from({ length: 5 }, (_, i) => ({ key: `review-test:${i}`, userKey: "viewer:review-user", replyKey: `viewer:${i}`, account: "viewer", userId: "review-user", replyId: String(i), rootId: String(i % 3), fingerprint: "fp", observedAt: now - i * 1000, label: "human_like", score: .7, confidence: .8,
  reviewContext: reviewContext({ id: String(i % 3), handle: "private-parent", userId: "123456789", text: "原帖正文" }, { id: String(i), parentId: String(i % 3), handle: "private-target", text: "评论正文" }, []) }));
test("review is opt-in, uses an upper bound without a thread quota, and excludes stale or withdrawn evidence", () => {
  assert.equal(normalizeObserverSettings({}).mode, "cumulative");
  assert.equal(normalizeObserverSettings({ accountReview: true }).mode, "cumulative");
  assert.deepEqual(selectReviewSamples(rows, { ...config, mode: "cumulative" }, "fp"), []);
  assert.equal(selectReviewSamples([rows[0], rows[0], rows[1]], config, "fp").length, 2);
  assert.equal(selectReviewSamples(rows.map(r => ({ ...r, rootId: "same" })), config, "fp").length, 3);
  assert.equal(selectReviewSamples(rows, { ...config, reviewMinReplies: 7 }, "fp").length, 5);
  assert.equal(selectReviewSamples([rows[0]], config, "fp").length, 1);
  assert.equal(selectReviewSamples([...rows, { ...rows[0], replyId: "old", observedAt: 0 }], config, "fp").length, 3);
  assert.equal(selectReviewSamples(rows, { ...config, minHits: 99, minThreads: 99 }, "fp").length, 3, "cumulative counts do not restrict combined collection");
  assert.equal(selectReviewSamples(rows, { ...config, reviewMinReplies: 5 }, "fp").length, 5);
  assert.deepEqual(selectReviewSamples(rows.map(r => ({ ...r, withdrawn: true })), config, "fp"), []);
});
test("review requests contain bounded text and current categories, never local identities or old probabilities", () => {
  const request = buildAccountReviewRequest(rows, "test-model", config), serialized = JSON.stringify(request);
  assert.equal(serialized.includes("private-target"), false); assert.equal(serialized.includes("123456789"), false);
  assert.equal(JSON.parse(request.state).samples.length, 5);
  assert.ok(request.questions.stance.instructions.includes(ACCOUNT_REVIEW_VERSION));
  const context = reviewContext({ text: "x".repeat(3000) }, { text: "y".repeat(3000) }, []);
  assert.equal(context.root.text.length, 1200); assert.equal(context.reply.text.length, 1800); assert.ok(context.reply.incomplete);
});
test("aggregate approval requires current policy and all source evidence, without altering single scores", () => {
  const result = { version: ACCOUNT_REVIEW_VERSION, fingerprint: "fp", policyKey: reviewPolicyKey(config), at: now, replyIds: rows.slice(0, 3).map(r => r.replyId), decision: { label: "ai_generated", score: .98, confidence: .95 } };
  const entries = rows.map((r, i) => i ? r : { ...r, accountReview: result });
  assert.ok(eligibleAccountReview(entries, config, "fp"));
  assert.equal(entries[0].label, "human_like");
  assert.equal(eligibleAccountReview(entries, { ...config, mode: "cumulative" }, "fp"), null);
  assert.equal(eligibleAccountReview(entries, { ...config, reviewThreshold: .99 }, "fp"), null);
  assert.equal(eligibleAccountReview(entries.slice(0, 2), config, "fp"), null);
  assert.equal(eligibleAccountReview(entries.map((r, i) => i === 1 ? { ...r, withdrawn: true } : r), config, "fp"), null);
});
test("persistent review reservations limit repeat cost and disabling invalidates in-flight writes", async () => {
  const userKey = "viewer:review-user";
  for (const r of rows) await saveObserverEvidence(r, 0);
  assert.equal(await reserveAccountReview(userKey, 0, "fp", ["0", "1", "2"], now), true);
  assert.equal(await reserveAccountReview(userKey, 0, "fp", ["2", "3", "4"], now + 1000), false);
  assert.equal(await reserveAccountReview(userKey, 0, "fp", ["0", "1", "2"], now + 3600001), false);
  assert.equal(await reserveAccountReview(userKey, 0, "fp", ["0", "1", "2", "3", "4"], now + 3600001), true);
  await saveObserverEvidence({ ...rows[0], key: "review-test:extra", replyId: "extra", observedAt: now + 1 }, 0);
  const retained = await readObserverUser("viewer", "review-user");
  assert.equal(retained.length, 6); assert.equal(retained.filter(e => e.reviewContext).length, 6, "old scores survive bounded context retention");
  await clearAccountReviewData();
  assert.ok(await observerEpoch("viewer", "review-user") > 0);
  assert.equal(await saveAccountReview(rows[0].key, 0, { at: now }), false);
  assert.ok((await readObserverUser("viewer", "review-user")).every(e => !e.reviewContext && !e.accountReview));
  await forgetObserverUser("viewer", "review-user");
  assert.equal(await reserveAccountReview(userKey, 0, "fp", ["5", "6", "7"], now + 7200001), false);
});
