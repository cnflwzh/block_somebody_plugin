import { DEFAULTS, STANCE_PROMPT_VERSION, JEV_CACHE_TTL } from "./core.js";
let cache;
let chain = Promise.resolve();
/** Only trusted extension contexts may access persisted data, especially the Jev secret. */
export const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const { state } = await chrome.storage.local.get("state");
  cache = state || { version: 1, settings: { ...DEFAULTS }, whitelist: [], history: [], jobs: [], sessions: {}, nextActionAt: 0, queueError: "", modelError: "" };
  cache.settings = { ...DEFAULTS, ...cache.settings };
  // Versions through 0.1.10 incorrectly made one invalid answer a persistent service-wide outage.
  if (/^Jev (概率分布不一致|返回的分类格式无效)/.test(cache.modelError)) cache.modelError = "";
  // Existing custom block thresholds can be below the new default mask threshold.
  cache.settings.maskThreshold = Math.min(cache.settings.maskThreshold, cache.settings.high - 0.01);
  // Only live analysis caches expire. Historical decisions and existing blocks remain auditable.
  // The normal DOM scan re-evaluates visible replies, respecting pause/whitelist/exclusion rules.
  for (const session of Object.values(cache.sessions)) {
    session.results = Object.fromEntries(Object.entries(session.results || {}).filter(([, result]) => result.promptVersion === STANCE_PROMPT_VERSION && (result.analyzedAt || session.created || 0) > Date.now() - JEV_CACHE_TTL));
    session.count = Object.keys(session.results).length;
  }
  // A worker may have stopped after a request was submitted. Do not blindly replay it.
  for (const job of cache.jobs) if (job.status === "running") {
    if (job.kind === "block" && !job.submitted) {
      job.status = "pending";
      const h = cache.history.find(h => h.id === job.historyId);
      if (h) h.status = "pending";
      continue;
    }
    if (job.kind === "block" && job.transport === "worker") {
      // The request may have reached X; never automatically send it a second time.
      job.status = "failed";
      job.error = "后台中断，未收到请求的最终 HTTP 结果；未自动重试，可在记录中手动处理。";
      const h = cache.history.find(h => h.id === job.historyId);
      if (h) { h.status = "failed"; h.error = job.error; }
      continue;
    }
    job.status = job.submitted ? "uncertain" : "failed";
    job.error = job.submitted ? "后台中断，结果待核对。请在历史中核对状态后重试。" : "后台在提交操作前中断，可以重试。";
    const h = cache.history.find(h => h.id === job.historyId);
    if (h) { h.status = job.submitted ? "uncertain" : job.kind === "unblock" ? "undo_failed" : "failed"; h.error = job.error; }
    cache.queueError = job.error;
  }
  await chrome.storage.local.set({ state: cache });
})();
/** Return an isolated snapshot after all earlier writes; callers cannot mutate the live store. */
export async function read() { await ready; await chain; return structuredClone(cache); }
/** Serialize state changes. Optional jevKey is stored atomically with connection settings,
 * outside state so it never appears in snapshots. Roll back in-memory state on quota errors.
 */
export function change(fn, { jevKey } = {}) {
  const run = chain.then(async () => {
    await ready;
    const next = structuredClone(cache);
    const result = fn(next);
    // Keep active records; trim only completed queue jobs, never blocked-account history.
    const active = [], done = [];
    for (const job of next.jobs) {
      if (["pending", "running", "uncertain", "failed"].includes(job.status)) active.push(job);
      else done.push(job);
    }
    next.jobs = [...active, ...done.slice(-200)];
    await chrome.storage.local.set({ state: next, ...(jevKey === undefined ? {} : { jevKey }) });
    cache = next;
    return result;
  });
  chain = run.catch(() => {});
  return run;
}
export async function key() { await ready; return (await chrome.storage.local.get("jevKey")).jevKey || ""; }
export async function saveKey(value) { await ready; await chrome.storage.local.set({ jevKey: value }); }
