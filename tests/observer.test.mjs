import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { OBSERVER_DEFAULTS, normalizeObserverSettings, buildObserverRequest, parseObserverDecision, summarizeObserverEvidence } from "../src/lib/observer-core.js";
import { observerEvidenceKey, observerUserKey, saveObserverEvidence, readObserverUser, readObserverReplies, observerEpoch, forgetObserverUser, reserveObserverBudget, readObserverBudget, cleanObserverEvidence } from "../src/lib/observer-store.js";

const config = { ...OBSERVER_DEFAULTS };
const now = Date.now();
const evidence = (replyId, rootId, extra = {}) => ({ replyId, rootId, observedAt: now, fingerprint: "rule-a", label: "spam", score: .96, confidence: .97, ...extra });

test("observer requires independent comments, multiple threads and recent normal evidence", () => {
  const first = evidence("100001", "100000");
  assert.equal(summarizeObserverEvidence([first, first, first], config, "rule-a", now).eligible, false);
  const rows = [first, evidence("100002", "100000"), evidence("200001", "200000")];
  assert.equal(summarizeObserverEvidence(rows, config, "rule-a", now).eligible, true);
  rows.push(evidence("300001", "300000", { label: "normal", observedAt: now + 1 }));
  assert.equal(summarizeObserverEvidence(rows, config, "rule-a", now).hitRate, .75);
  rows.push(evidence("300002", "300000", { label: "normal", observedAt: now + 2 }));
  assert.equal(summarizeObserverEvidence(rows, config, "rule-a", now).eligible, false);
});

test("observer isolates rule versions, expired evidence, withdrawals and simulations", () => {
  const rows = [evidence("100001", "100000"), evidence("200001", "200000"), evidence("300001", "300000")];
  for (const patch of [{ fingerprint: "old-rule" }, { observedAt: now - 31 * 86400000 }, { withdrawn: true }, { simulation: true }, { confidence: .4 }, { label: "uncertain" }]) {
    assert.equal(summarizeObserverEvidence(rows.map(e => ({ ...e, ...patch })), config, "rule-a", now).eligible, false);
  }
  assert.equal(summarizeObserverEvidence(rows.map(e => ({ ...e, simulation: true })), { ...config, includeDryRun: true }, "rule-a", now).eligible, true);
});

test("observer validates choices and does not label normal winner probability as spam", () => {
  const probabilities = { spam: .01, useful: .01, normal: .97, uncertain: .01 };
  const answer = { answers: { stance: { type: "choice", choice: "normal", confidence: .99, probabilities } } };
  const result = parseObserverDecision(answer, config);
  assert.equal(result.suspicious, false); assert.equal(result.spamScore, .01);
  assert.throws(() => parseObserverDecision({ answers: { stance: { ...answer.answers.stance, choice: "spam" } } }, config));
  assert.throws(() => parseObserverDecision({ answers: { stance: { ...answer.answers.stance, probabilities: { ...probabilities, normal: NaN } } } }, config));
  const request = buildObserverRequest({ text: "root", handle: "private-name" }, { text: "reply" }, [], "model", config);
  assert.equal(JSON.stringify(request).includes("private-name"), false);
});

test("observer policy rejects unknown keys and invalid cumulative thresholds", () => {
  assert.equal(normalizeObserverSettings({ enabled: true }).enabled, true);
  for (const input of [{ scope: "verified" }, { enabled: 1 }, { threshold: NaN }, { minHits: 1 }, { minThreads: 4, minHits: 3 }, { typo: true }]) assert.throws(() => normalizeObserverSettings(input));
});

test("observer store deduplicates concurrent replies and rejects evidence arriving after undo", async () => {
  const account = "fixture", userId = "900001", epoch = await observerEpoch(account, userId);
  const entry = { ...evidence("100001", "100000"), key: observerEvidenceKey(account, "100001", "rule-a"), userKey: observerUserKey(account, userId), replyKey: `${account}:100001`, account, userId, handle: "example" };
  const saved = await Promise.all([saveObserverEvidence(entry, epoch), saveObserverEvidence(entry, epoch)]);
  assert.equal(saved.filter(Boolean).length, 1);
  assert.equal((await readObserverUser(account, userId)).length, 1);
  assert.equal((await readObserverReplies("other", ["100001"])).length, 0);
  await forgetObserverUser(account, userId);
  assert.equal((await readObserverUser(account, userId))[0].withdrawn, true);
  assert.equal(await saveObserverEvidence({ ...entry, key: "late-result", replyId: "100002" }, epoch), false);
  assert.equal(await saveObserverEvidence({ ...entry, key: "new-result", replyId: "100003" }, await observerEpoch(account, userId)), true);
  await cleanObserverEvidence(30, 1);
  assert.equal((await readObserverUser(account, userId)).length, 1);
});

test("observer budget reservations remain atomic and roll over on a new UTC day", async () => {
  const day = Date.UTC(2026, 0, 1);
  const reserved = await Promise.all(Array.from({ length: 20 }, () => reserveObserverBudget(7, day)));
  assert.equal(reserved.filter(Boolean).length, 7);
  assert.equal(await readObserverBudget(day), 7);
  assert.equal(await reserveObserverBudget(7, day + 86400000), true);
  assert.equal(await readObserverBudget(day + 86400000), 1);
});
