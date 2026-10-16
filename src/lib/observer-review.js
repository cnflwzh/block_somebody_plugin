import { buildObserverRequest, observerSuspicious } from "./observer-core.js";
export const ACCOUNT_REVIEW_VERSION = "account-review-v2";
const MAX_SAMPLES = 5;

/** Capture bounded text only after opt-in. Identities remain local for protection checks;
 * buildAccountReviewRequest sends text, never handles or numeric account identifiers.
 */
export function reviewContext(root, reply, ancestors) {
  const copy = (p, max) => ({ id: p.id, handle: p.handle, userId: p.userId, text: p.text.slice(0, max), hasMedia: !!p.hasMedia, incomplete: !!p.incomplete || p.text.length > max });
  return { root: copy(root, 1200), reply: { ...copy(reply, 1800), parentId: reply.parentId }, ancestors: ancestors.slice(0, 2).map(p => copy(p, 600)), truncatedAncestors: ancestors.length > 2 };
}

/** Latest collected replies; no single-reply model score is required or requested. */
export function selectReviewSamples(rows, config, fingerprint, now = Date.now()) {
  if (config.mode !== "combined" || !config.enabled) return [];
  const unique = new Map();
  for (const e of rows) if (e.reviewContext && !e.error && !e.withdrawn && (!e.simulation || config.includeDryRun)
    && e.fingerprint === fingerprint && e.observedAt > now - config.retentionDays * 86400000) {
    const old = unique.get(e.replyId); if (!old || old.observedAt < e.observedAt) unique.set(e.replyId, e);
  }
  const samples = [...unique.values()].sort((a, b) => b.observedAt - a.observedAt).slice(0, MAX_SAMPLES);
  // These are collection requirements, independent of cumulative-mode positive counts.
  if (samples.length < config.reviewMinReplies || new Set(samples.map(e => e.rootId)).size < config.reviewMinThreads) return [];
  return samples;
}

/** One choice request over the selected user's replies. Reuses custom category criteria. */
export function buildAccountReviewRequest(samples, model, config) {
  if (!samples.length) throw new Error("Missing account review samples");
  const requests = samples.map(e => { const c = e.reviewContext; return buildObserverRequest(c.root, c.reply, c.ancestors, model, config); });
  const request = requests[0];
  request.state = JSON.stringify(samples.map((e, i) => ({ sample: i + 1, thread: samples.findIndex(p => p.rootId === e.rootId) + 1,
    context: requests[i].state, truncated: e.reviewContext.truncatedAncestors || [e.reviewContext.root, e.reviewContext.reply, ...e.reviewContext.ancestors].some(p => p.incomplete) })));
  request.questions.stance.instructions += `\n账号复核 ${ACCOUNT_REVIEW_VERSION}：以上是同一作者在不同讨论中的近期回复。按下方类别标准判断这些回复整体体现的持续模式，不是只判断最后一句。比较跨话题反复出现的论证骨架、同组素材的复用、固定咨询式追问和刻意口语化的完整点评。切题或正确不排除生成；不把原帖作者的话当成目标作者证据。选中拟屏蔽类别需该模式覆盖至少${Math.ceil(samples.length * config.reviewHitRate)}条样本；仅少数可疑或材料不足时不要将整个账号归为持续命中。`;
  if (request.state.length > 40000) throw Object.assign(new Error("Account review context exceeds limit"), { code: "OBSERVER_REVIEW_TOO_LARGE" });
  return request;
}

/** A review is separate from per-reply evidence and never changes individual probabilities. */
export function eligibleAccountReview(rows, config, fingerprint, now = Date.now(), requireHit = true) {
  if (config.mode !== "combined" || !config.enabled) return null;
  const available = new Map(rows.filter(e => !e.withdrawn && !e.error && (!e.simulation || config.includeDryRun) && e.fingerprint === fingerprint && e.observedAt > now - config.retentionDays * 86400000).map(e => [e.replyId, e]));
  for (const e of [...available.values()].sort((a, b) => b.observedAt - a.observedAt)) {
    const r = e.accountReview;
    if (!r || r.version !== ACCOUNT_REVIEW_VERSION || r.fingerprint !== fingerprint || r.policyKey !== reviewPolicyKey(config)
      || r.at <= now - config.retentionDays * 86400000 || requireHit && !observerSuspicious(r.decision, accountReviewConfig(config))) continue;
    const used = [...new Set(r.replyIds)].map(id => available.get(id));
    if (used.some(p => !p?.reviewContext) || used.length < config.reviewMinReplies || new Set(used.map(p => p.rootId)).size < config.reviewMinThreads) continue;
    return r;
  }
  return null;
}
export function reviewPolicyKey(config) { return JSON.stringify([config.mode, config.scope, config.skipFollowing, config.reviewThreshold, config.reviewConfidence, config.reviewMinReplies, config.reviewMinThreads, config.reviewHitRate, config.retentionDays]); }

/** Map independent combined-mode thresholds only for evaluating its model answer. */
export function accountReviewConfig(config) { return { ...config, threshold: config.reviewThreshold, confidence: config.reviewConfidence }; }
