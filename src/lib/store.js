import "./i18n.js";
const { t } = globalThis.BlockSBI18n;
import { DEFAULTS, STANCE_PROMPT_VERSION, JEV_CACHE_TTL } from "./core.js";
import { normalizeObserverSettings } from "./observer-core.js";
import { getFilterRules } from "./filter-rules.js";
let cache;
let chain = Promise.resolve();
/** Only trusted extension contexts may access persisted data, especially the Jev secret. */
export const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const { state } = await chrome.storage.local.get("state");
  cache = state || { version: 1, onboardingRequired: true, settings: { ...DEFAULTS }, whitelist: [], history: [], jobs: [], sessions: {}, nextActionAt: 0, queueError: "", modelError: "" };
  let dirty = !state;
  const settingsBefore = JSON.stringify(cache.settings);
  cache.settings = { ...DEFAULTS, ...cache.settings };
  // Upgrade the fixed AI/BNB switches once, preserving their enabled states.
  cache.settings.filterRules = getFilterRules(cache.settings);
  cache.settings.observer = normalizeObserverSettings(cache.settings.observer || {});
  // Versions through 0.1.10 incorrectly made one invalid answer a persistent service-wide outage.
  if (/^Jev (概率分布不一致|返回的分类格式无效)/.test(cache.modelError)) { cache.modelError = ""; dirty = true; }
  // Existing custom block thresholds can be below the new default mask threshold.
  cache.settings.maskThreshold = Math.min(cache.settings.maskThreshold, cache.settings.high - 0.01);
  // Only live analysis caches expire. Historical decisions and existing blocks remain auditable.
  // The normal DOM scan re-evaluates visible replies, respecting pause/whitelist/exclusion rules.
  dirty ||= settingsBefore !== JSON.stringify(cache.settings);
  for (const session of Object.values(cache.sessions)) {
    const previousCount = Object.keys(session.results || {}).length;
    session.results = Object.fromEntries(Object.entries(session.results || {}).filter(([, result]) => result.promptVersion === STANCE_PROMPT_VERSION && (result.analyzedAt || session.created || 0) > Date.now() - JEV_CACHE_TTL));
    const count = Object.keys(session.results).length;
    dirty ||= previousCount !== count || session.count !== count;
    session.count = count;
  }
  // A worker may have stopped after a request was submitted. Do not blindly replay it.
  const historyById = new Map(cache.history.map(h => [h.id, h]));
  for (const job of cache.jobs) {
    // Older workers stored both lost responses and definite HTTP failures as failed.
    // Without a persisted outcome, require reconciliation instead of guessing from error text.
    const legacyUnknown = job.kind === "block" && job.transport === "worker" && job.status === "failed" && job.submitted && !job.resultKnown;
    if (job.status !== "running" && !legacyUnknown) continue;
    dirty = true;
    if (job.kind === "block" && !job.submitted) {
      job.status = "pending";
      const h = historyById.get(job.historyId);
      if (h) h.status = "pending";
      continue;
    }
    job.status = job.submitted ? "uncertain" : "failed";
    job.resultKnown = !job.submitted;
    job.error = job.submitted ? t("ui_background_interrupted_result_unknown_verify_the_status_before_retrying") : t("ui_background_interrupted_before_submission_you_can_retry");
    const h = historyById.get(job.historyId);
    if (h) { h.status = job.submitted ? "uncertain" : job.kind === "unblock" ? "undo_failed" : "failed"; h.error = job.error; }
    if (job.kind !== "block" || job.transport !== "worker") cache.queueError = job.error;
  }
  if (dirty) await chrome.storage.local.set({ state: cache });
})();
/** Return an isolated snapshot after earlier writes. Optional synchronous projection must not
 * mutate its input; projecting before cloning avoids copying unrelated histories and session results. */
export async function read(project = value => value) { await ready; await chain; return structuredClone(project(cache)); }
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
