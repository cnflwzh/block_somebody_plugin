import { getAnalysisRule, STANCE_PROMPT_VERSION, DECISION_VERSION, JEV_CACHE_TTL } from "./core.js";

/** Pure estimate over versioned, validated local scores. No cache writes, requests or actions.
 * Legacy scores without configuration provenance are intentionally excluded.
 */
export function previewStance(settings, candidate, sessions, now = Date.now()) {
  const rows = new Map();
  for (const session of sessions) for (const [replyId, result] of Object.entries(session.results || {})) {
    if (result.error || result.model !== settings.model || result.promptVersion !== STANCE_PROMPT_VERSION
      || result.analysisRevision !== (settings.analysisRevision || 0) || result.decisionVersion !== DECISION_VERSION
      || result.contextComplete !== true || !Number.isFinite(result.confidence) || !result.probabilities
      || !(result.analyzedAt > now - JEV_CACHE_TTL) || session.excluded?.includes(result.handle)) continue;
    const key = `${session.account}:${session.root.id}:${replyId}`, old = rows.get(key);
    if (!old || old.analyzedAt < result.analyzedAt) rows.set(key, result);
  }
  const options = getAnalysisRule(settings).options;
  const action = (r, config) => {
    const selected = options.filter(o => o.block), chosen = options.find(o => o.id === r.label);
    const probability = Math.max(0, ...selected.map(o => r.probabilities[o.id] || 0));
    if (chosen?.block && probability >= config.high && r.confidence >= config.confidence) return "block";
    if (config.maskEnabled && (r.customRule ? chosen?.block : !["oppose", "neutral"].includes(r.label)) && probability >= config.maskThreshold && probability < config.high) return "mask";
    return "keep";
  };
  let blocked = 0, masked = 0, changed = 0;
  for (const r of rows.values()) {
    const current = action(r, settings), next = action(r, candidate);
    blocked += next === "block"; masked += next === "mask"; changed += next !== current;
  }
  return { module: "stance", available: rows.size > 0, total: rows.size, matched: blocked + masked, blocked, masked, changed,
    ...(rows.size ? {} : { reason: "no-current-results" }) };
}
