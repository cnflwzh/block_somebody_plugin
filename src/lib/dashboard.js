/** Project retained local records into a bounded, read-only dashboard. Never schedules actions.
 * Input belongs to the extension worker. No credentials or full prompt/context are returned.
 */
export function dashboardSnapshot(db, observations, now = Date.now()) {
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const start = day.getTime(), records = [], analyzed = new Set(), covered = new Set();
  const history = db.history || [], rules = new Map((db.settings.filterRules || []).map(r => [r.id, r.name]));
  for (const h of history) {
    const modules = [];
    if (h.module === 'observer' || h.observerOwner) modules.push('observer');
    if (h.module === 'name' || h.nameOwner) modules.push('name');
    if (!['observer','name'].includes(h.module) || h.stanceOwner) modules.push('stance');
    records.push({ key: `history:${h.id}`, historyId: h.id, account: h.account, target: h.target,
      modules, ruleNames: (h.nameRuleIds || []).map(id => h.nameRuleNames?.[id] || rules.get(id) || id),
      status: h.status, at: h.updated || h.created, reason: h.reason, rootId: h.root?.id, replyId: h.reply?.id,
      probability: h.decision?.accountReview?.score ?? h.decision?.spamScore ?? h.decision?.support,
      combined: !!h.decision?.accountReview, owned: !!h.owned });
    if (h.reply?.id) covered.add(`${h.account}:${h.reply.id}`);
  }
  for (const e of db.filterEvents || []) {
    if (covered.has(`${e.account}:${e.replyId}`)) continue;
    records.push({ key: `filter:${e.key}`, account: e.account, target: e.target, modules: ['name'],
      ruleNames: e.names || [], status: e.action === 'mask' ? 'masked' : 'observing', at: e.created, rootId: e.rootId, replyId: e.replyId });
  }
  const reviews = new Map();
  for (const e of observations) {
    if (e.error || e.withdrawn || e.simulation) continue;
    if (e.label !== 'collected' && e.observedAt >= start) analyzed.add(`observer:${e.account}:${e.replyId}`);
    const review = e.accountReview;
    if (review?.at >= start) analyzed.add(`review:${e.account}:${e.userId}:${review.at}`);
    if (covered.has(`${e.account}:${e.replyId}`)) continue;
    const key = `${e.account}:${e.userId}`;
    const old = reviews.get(key), at = review?.at || e.observedAt;
    if (!old || old.at < at) reviews.set(key, { key: `observer:${key}`, account: e.account,
      target: { handle: e.handle, name: e.name, userId: e.userId }, modules: ['observer'], ruleNames: [],
      status: (review?.decision?.label || e.label) === 'human_like' ? 'skipped' : 'observing', at,
      probability: review?.decision?.spamScore ?? e.spamScore, combined: !!review, rootId: e.rootId, replyId: e.replyId });
  }
  records.push(...reviews.values());
  for (const s of Object.values(db.sessions || {})) for (const [id, result] of Object.entries(s.results || {})) {
    if (result.analyzedAt >= start) analyzed.add(`stance:${s.account}:${id}`);
  }
  const today = history.filter(h => (h.updated || h.created) >= start);
  return { analyzed: analyzed.size, pending: history.filter(h => ['pending','running'].includes(h.status)).length,
    submitted: today.filter(h => ['submitted','blocked'].includes(h.status)).length,
    activeTasks: Object.values(db.sessions || {}).filter(s => !s.stopped).length,
    records: records.sort((a,b) => b.at-a.at).slice(0,300), retained: true };
}
