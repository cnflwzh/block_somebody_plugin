import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { OBSERVER_DEFAULTS, normalizeObserverSettings, observerExempt, buildObserverRequest, parseObserverDecision, summarizeObserverEvidence } from "../src/lib/observer-core.js";
import { observerEvidenceKey, observerUserKey, saveObserverEvidence, readObserverUser, readObserverReplies, observerEpoch, forgetObserverUser, reserveObserverBudget, readObserverBudget, cleanObserverEvidence } from "../src/lib/observer-store.js";

const config = { ...OBSERVER_DEFAULTS };
const now = Date.now();
const evidence = (replyId, rootId, extra = {}) => ({ replyId, rootId, observedAt: now, fingerprint: "rule-a", label: "ai_generated", score: .96, confidence: .97, ...extra });

test("observer counts distinct replies without thread or recent-ratio gates", () => {
  const first = evidence("100001", "100000");
  assert.equal(summarizeObserverEvidence([first, first, first], config, "rule-a", now).eligible, false);
  assert.equal(config.minThreads, undefined);
  assert.equal(summarizeObserverEvidence([first], { ...config, minHits: 1 }, "rule-a", now).eligible, true);
  assert.equal(summarizeObserverEvidence([first, evidence("100002", "100000")], { ...config, minHits: 2 }, "rule-a", now).eligible, true);
  const rows = [first, evidence("100002", "300000"), evidence("200001", "200000")];
  assert.equal(summarizeObserverEvidence(rows, config, "rule-a", now).eligible, true);
  rows.push(evidence("300001", "300000", { label: "human_like", observedAt: now + 1 }));
  assert.equal(summarizeObserverEvidence(rows, config, "rule-a", now).hitRate, .75);
  rows.push(evidence("300002", "300000", { label: "human_like", observedAt: now + 2 }));
  assert.equal(summarizeObserverEvidence(rows, config, "rule-a", now).eligible, true);
});

test("observer isolates rule versions, expired evidence, withdrawals and simulations", () => {
  const rows = [evidence("100001", "100000"), evidence("200001", "200000"), evidence("300001", "300000")];
  for (const patch of [{ fingerprint: "old-rule" }, { observedAt: now - 31 * 86400000 }, { withdrawn: true }, { simulation: true }, { confidence: .4 }, { label: "uncertain" }]) {
    assert.equal(summarizeObserverEvidence(rows.map(e => ({ ...e, ...patch })), config, "rule-a", now).eligible, false);
  }
  assert.equal(summarizeObserverEvidence(rows.map(e => ({ ...e, simulation: true })), { ...config, includeDryRun: true }, "rule-a", now).eligible, true);
});

test("observer validates choices and does not label normal winner probability as spam", () => {
  const probabilities = { ai_generated: .01, human_like: .98, uncertain: .01 };
  const answer = { answers: { stance: { type: "choice", choice: "human_like", confidence: .99, probabilities } } };
  const result = parseObserverDecision(answer, config);
  assert.equal(result.suspicious, false); assert.equal(result.spamScore, .01);
  assert.throws(() => parseObserverDecision({ answers: { stance: { ...answer.answers.stance, choice: "ai_generated" } } }, config));
  assert.throws(() => parseObserverDecision({ answers: { stance: { ...answer.answers.stance, probabilities: { ...probabilities, human_like: NaN } } } }, config));
  const request = buildObserverRequest({ text: "root", handle: "private-name" }, { text: "reply" }, [], "model", config);
  assert.equal(JSON.stringify(request).includes("private-name"), false);
});

test("observer policy rejects unknown keys and invalid cumulative thresholds", () => {
  assert.equal(normalizeObserverSettings({ enabled: true }).enabled, true);
  const migrated = normalizeObserverSettings({ minHits: 1, minThreads: 4, hitRate: 1, dailyLimit: 1, retentionDays: 7 });
  assert.equal(migrated.minHits, 1); assert.equal(migrated.retentionDays, 30);
  for (const retired of ["minThreads", "hitRate", "dailyLimit"]) assert.equal(retired in migrated, false);
  for (const input of [{ scope: "verified" }, { enabled: 1 }, { threshold: NaN }, { minHits: 0 }, { minHits: 101 }, { typo: true }]) assert.throws(() => normalizeObserverSettings(input));
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

test("official Grok exemption matches the handle, not display names or lookalikes", () => {
  assert.equal(observerExempt({ handle: "Grok" }), true);
  assert.equal(observerExempt({ handle: "@grok" }), true);
  assert.equal(observerExempt({ handle: "grok_helper", name: "Grok" }), false);
});
