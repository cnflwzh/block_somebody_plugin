import { getReviewRule, normalizeReviewRule } from "./lib/observer-review-rule.js";
import { createSubscriptionService } from "./lib/filter-subscriptions.js";
import { LEGAL_VERSION } from "./lib/legal.js";
import { dashboardSnapshot } from "./lib/dashboard.js";
import "./lib/i18n.js";
const { t } = globalThis.BlockSBI18n;
import { read, change, key, ready } from "./lib/store.js";
import { PRESETS, DEFAULT_ENDPOINT, JEV_CACHE_TTL, STANCE_PROMPT_VERSION, DECISION_VERSION, decideAction, normalizeHandle, sanitizePost, numericId, isWhitelisted, sameTarget, matchingNameRules, updateSettings, buildRequest, parseDecision, validateThread } from "./lib/core.js";
import { askJev } from "./lib/jev.js";
import { askJevCached, cleanJevCache, clearJevCache, requestKey } from "./lib/jev-cache.js";
import { xSession, postBlock } from "./lib/x-block.js";
import { getFilterRules, getProcessingFilters, normalizeFilters, filterStamp } from "./lib/filter-rules.js";
import { evaluateFilters } from "./lib/filter-evaluator.js";
import { getAnalysisRule, normalizeRule, customRuleEnabled } from "./lib/core.js";
import { syncThreadContext } from "./lib/thread-context.js";
import { OBSERVER_VERSION, observerExempt, getObserverRule, normalizeObserverRule, observerBuiltinCategories, observerRuleIdentity, observerSuspicious, normalizeObserverSettings, buildObserverRequest, parseObserverDecision, summarizeObserverEvidence } from "./lib/observer-core.js";
import { observerUserKey, observerEvidenceKey, readObserverEvidence, readObserverUser, readObserverAll, readObserverReplies, observerEpoch, saveObserverEvidence, markObserverEvaluated, forgetObserverUser, reserveObserverBudget, readObserverBudget, cleanObserverEvidence } from "./lib/observer-store.js";

import { contentExcepted, addContentException } from "./lib/content-exceptions.js";
import { previewStance } from "./lib/settings-preview.js";
import { ACCOUNT_REVIEW_VERSION, reviewContext, selectReviewSamples, buildAccountReviewRequest, eligibleAccountReview, reviewPolicyKey, accountReviewConfig } from "./lib/observer-review.js";
import { reserveAccountReview, saveAccountReview, clearAccountReviewData } from "./lib/observer-store.js";
import { reserveReplyCollection, finishReplyCollection, readReplyCollection, readReplyCollections } from "./lib/observer-store.js";
import { collectRecentReplies } from "./lib/observer-collection.js";
import { summarizeAccountSignals } from "./lib/account-signals.js";
import { readNormalAccount, saveNormalAccount, listNormalAccounts, removeNormalAccount } from "./lib/observer-store.js";

const subscriptions = createSubscriptionService({ read, change, revoke: invalidateNameJobs, changed: () => { notify(); void drain(); } });
const filterSeeds = new Map();
const X_URLS = ["https://x.com/*", "https://twitter.com/*"];
const flights = new Map();
const observerFlights = new Map();
const observerSimulations = new Set();
// Ephemeral capabilities: a page can undo only its own freshly enqueued batch.
const quickUndoBatches = new Map();
let observerFinalizing = Promise.resolve();
let draining = false;
let drainTimer;
let notifyTimer;
let observerCleanupAt = 0;
const id = () => crypto.randomUUID();
const isX = url => { try { return ["x.com", "twitter.com"].includes(new URL(url).hostname) && new URL(url).protocol === "https:"; } catch { return false; } };
const postId = url => { try { return new URL(url).pathname.match(/^\/[\w]+\/status\/(\d+)(?:\/|$)/)?.[1] || ""; } catch { return ""; } };
const extensionOrigin = chrome.runtime.getURL("");

/** Read the tab's current SPA route, not the URL captured by a message's script context.
 * A missing/closed/non-X tab never authorizes a new analysis or manual action.
 */
async function currentPostId(sender) {
  const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
  return tab && isX(tab.url) && !tab.incognito ? postId(tab.url) : "";
}

/** Broadcast only a change notification, never credentials or another account's history. */
function notify() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(async () => {
    const tabs = await chrome.tabs.query({ url: X_URLS });
    await Promise.allSettled(tabs.map(t => chrome.tabs.sendMessage(t.id, { type: "STATE_CHANGED" })));
    chrome.runtime.sendMessage({ type: "STATE_CHANGED" }).catch(() => {});
  }, 100);
}
async function snapshot(sender, accountValue, view) {
  const manager = sender.url?.startsWith(extensionOrigin);
  const scoped = manager && ["dashboard", "settings", "observer", "history", "whitelist", "name-rules"].includes(view);
  // Project before cloning: settings/observer views do not need thousands of history
  // texts or live session results. Content-script snapshots retain their existing contract.
  const db = await read(d => !scoped ? d : ({
    legalAcceptance: d.legalAcceptance, onboardingRequired: d.onboardingRequired, filterSubscriptions: d.filterSubscriptions,
    settings: d.settings, whitelist: d.whitelist, debugDryRun: d.debugDryRun,
    history: view === "settings" || view === "whitelist" ? [] : view === "observer"
      ? d.history.filter(h => h.module === "observer" || h.observerOwner) : view === "name-rules" ? d.history.filter(h => h.nameRuleIds?.length) : d.history,
    jobs: view === "dashboard" || view === "history" || view === "name-rules" ? d.jobs.filter(j => j.status === "pending") : [],
    sessions: view === "dashboard" || view === "history" || view === "name-rules" ? Object.fromEntries(Object.entries(d.sessions).map(([key, session]) => [key,
      { id: session.id, tabId: session.tabId, account: session.account, root: session.root, created: session.created, stopped: session.stopped, following: session.following, ...(view === "dashboard" ? { results: session.results } : {}) }])) : {},
    observerFollowing: view === "dashboard" || view === "history" || view === "name-rules" ? d.observerFollowing : {},
    filterEvents: view === "dashboard" || view === "name-rules" ? d.filterEvents : [], filterErrors: view === "dashboard" || view === "name-rules" ? d.filterErrors : {},
    observerSnoozedUntil: d.observerSnoozedUntil, contentExceptions: d.contentExceptions,
    nextActionAt: d.nextActionAt, queueError: d.queueError, queueNotice: d.queueNotice, modelError: d.modelError
  }));
  const settings = { ...db.settings, configured: !!(await key()), debugDryRun: !!db.debugDryRun, legalAcceptance: db.legalAcceptance || null, needsOnboarding: !!db.onboardingRequired };
  // Waiting is a presentation flag, not a terminal job status: undo/cancel and restart
  // recovery must continue to treat legacy jobs without relationship evidence as pending.
  // Build this index once per snapshot instead of scanning all history for each job.
  // Keep it local to this immutable read; queue mutations must use their current records.
  const historyById = new Map(db.history.map(h => [h.id, h]));
  const waitingHistory = new Set();
  for (const job of db.jobs) {
    if (job.status === "pending" && waitingFollowingJob(db, job, historyById)) waitingHistory.add(job.historyId);
  }
  const history = db.history.map(h => ({ ...h, waitingFollowing: h.status === "pending" && waitingHistory.has(h.id) }));
  if (sender.url?.startsWith(extensionOrigin)) return { filterSubscriptions: (db.filterSubscriptions || []).map(({ id, url, autoUpdate, lastCheck, lastAttempt, error, rules }) => ({ id, url, autoUpdate, lastCheck, lastAttempt, error, count: rules.length, rules: rules.map(({ name, action }) => ({ name, action })) })), dashboard: view === "dashboard" ? dashboardSnapshot(db, await readObserverAll()) : null, settings, presets: PRESETS, whitelist: db.whitelist, history: history.slice().reverse(), nextActionAt: db.nextActionAt || 0, filterEvents: db.filterEvents || [], filterErrors: db.filterErrors || {}, sessions: Object.values(db.sessions).map(({ following, ...session }) => session), observer: !scoped || view === "observer" ? await observerSnapshot(db) : null, view: scoped ? view : "all", queueError: db.queueError, queueNotice: db.queueNotice || "", modelError: db.modelError };
  const s = db.sessions[sender.tab.id];
  const account = accountValue ? normalizeHandle(accountValue) : "";
  const { endpoint, customPrompt, analysisRule, legalAcceptance, needsOnboarding, ...pageSettings } = settings;
  if (pageSettings.observer) {
    const { prompt, analysisRule, reviewRule, ...publicObserver } = pageSettings.observer, rule = getObserverRule(pageSettings.observer);
    if (publicObserver.mode === "combined") { publicObserver.showMarkers = true; publicObserver.mask = false; }
    pageSettings.observer = { ...publicObserver, revision: db.observerPolicyRevision || 0, customRule: !observerBuiltinCategories(rule), ruleOptions: rule.options.map(({ id, name, block }) => ({ id, name, block })) };
  }
  pageSettings.customRule = customRuleEnabled(settings);
  // The page needs display names and action markers, not the private templates or rubric text.
  pageSettings.ruleOptions = getAnalysisRule(settings).options.map(({ id, name, block }) => ({ id, name, block }));
  return { settings: pageSettings, account, contentExceptions: (db.contentExceptions || []).filter(e => e.account === account && e.expires > Date.now()), quickUndo: quickUndoSnapshot(sender.tab.id, account), decisionVersion: DECISION_VERSION, whitelist: db.whitelist.map(w => ({ handle: w.handle, userId: w.userId })), session: s?.account === account ? s : null, queueError: db.queueError, queueNotice: db.queueNotice || "", modelError: db.modelError,
    history: history.filter(h => h.account === account).map(h => ({ id: h.id, target: h.target, status: h.status, trashUnread: !!h.trashUnread, module: h.module, observerOwner: !!h.observerOwner, nameOwner: !!h.nameOwner, nameRuleIds: h.nameRuleIds, nameRootIds: h.nameRootIds, nameRuleWithdrawn: !!h.nameRuleWithdrawn, waitingFollowing: h.waitingFollowing, undoRequested: !!h.undoRequested, sessionId: h.sessionId, rootId: h.root?.id, replyId: h.reply?.id, updated: h.updated })) };
}
/** Return the newest relationship record, including queues from other tabs/modules. */
function analysisAlreadyHandled(db, account, target) {
  const h = db.history.findLast(h => h.account === account && sameTarget(h.target, target));
  return !!h && ["pending", "running", "submitted", "blocked", "preexisting", "undo_pending", "undo_running", "uncertain"].includes(h.status);
}
/** Issue a short-lived, tab/account-bound grant only for new automatic reply jobs. */
function offerQuickUndo(s, h) {
  if (!Number.isInteger(s.tabId)) return;
  const now = Date.now();
  for (const [tab, batch] of quickUndoBatches) if (batch.expires <= now) quickUndoBatches.delete(tab);
  let batch = quickUndoBatches.get(s.tabId);
  if (!batch || batch.account !== s.account || batch.rootId !== s.root.id || batch.items.length >= 20 || now - batch.created > 60000) {
    batch = { token: id(), account: s.account, actorId: s.actorId, rootId: s.root.id, created: now, items: [] };
    quickUndoBatches.set(s.tabId, batch);
  }
  batch.items.push({ id: h.id, module: h.module, sessionId: h.sessionId });
  batch.expires = now + 15000;
  while (quickUndoBatches.size > 100) quickUndoBatches.delete(quickUndoBatches.keys().next().value);
}
function quickUndoSnapshot(tabId, account) {
  const batch = quickUndoBatches.get(tabId);
  if (!batch || batch.expires <= Date.now()) { quickUndoBatches.delete(tabId); return null; }
  return batch.account === account ? { token: batch.token, count: batch.items.length, expires: batch.expires } : null;
}
/** User correction pauses fresh observation for one day; old evidence is withdrawn separately. */
function snoozeObserver(db, account, userId) {
  if (!userId) return;
  db.observerSnoozedUntil ||= {};
  const now = Date.now();
  for (const [key, until] of Object.entries(db.observerSnoozedUntil)) if (until <= now) delete db.observerSnoozedUntil[key];
  db.observerSnoozedUntil[observerUserKey(account, userId)] = now + 86400000;
  const entries = Object.entries(db.observerSnoozedUntil);
  if (entries.length > 5000) for (const [key] of entries.sort((a, b) => a[1] - b[1]).slice(0, entries.length - 5000)) delete db.observerSnoozedUntil[key];
}
/** Consume a grant once, cancel unsent jobs and schedule undo only for owned successful POSTs.
 * Never accepts arbitrary history IDs or revokes another task's subsequently acquired ownership.
 */
async function quickUndo(message, sender) {
  const account = normalizeHandle(message.account), batch = quickUndoBatches.get(sender.tab.id);
  if (!batch || batch.token !== message.token || batch.account !== account || batch.expires <= Date.now()) throw new Error(t("ui_quick_undo_expired"));
  if (!Number.isInteger(message.count) || message.count < 1 || message.count > batch.items.length) throw new Error(t("ui_invalid_request_source"));
  const items = batch.items.slice(0, message.count);
  const binding = await bindAccount(sender.tab.id, account);
  if (quickUndoBatches.get(sender.tab.id) !== batch || batch.expires <= Date.now() || batch.actorId && batch.actorId !== binding.actorId) throw new Error(t("ui_quick_undo_expired"));
  quickUndoBatches.delete(sender.tab.id);
  const result = await change(d => {
    if (batch.expires <= Date.now()) throw new Error(t("ui_quick_undo_expired"));
    const targets = [];
    for (const item of items) {
      const h = d.history.find(h => h.id === item.id && h.account === account);
      if (!h || h.module !== item.module || h.sessionId !== item.sessionId
        || d.history.findLast(other => other.account === account && sameTarget(other.target, h.target))?.id !== h.id
        || [h.stanceOwner, h.observerOwner, h.nameOwner].filter(Boolean).length > 1
        || h.nameRootIds?.some(root => root !== batch.rootId)
        || !["pending", "running", "submitted", "blocked"].includes(h.status)) continue;
      const jobs = d.jobs.filter(j => j.historyId === h.id && j.kind === "block");
      const active = jobs.find(j => ["pending", "running"].includes(j.status));
      if (!active && !h.owned) continue;
      h.undoRequested = true; h.taskWithdrawn = true; h.stanceOwner = false; h.observerOwner = false; h.nameOwner = false;
      h.nameRuleWithdrawn = true;
      if (h.target.userId) { d.nameRuleExclusions ||= {}; d.nameRuleExclusions[`${account}:${h.target.userId}`] = true; }
      snoozeObserver(d, account, h.target.userId);
      for (const session of Object.values(d.sessions)) if (session.account === account && !session.excluded.includes(h.target.handle)) session.excluded.push(h.target.handle);
      for (const j of jobs) { j.observerAuthorizationRevoked = true; j.nameAuthorizationRevoked = true; }
      if (active) {
        if (!active.submitted) { active.status = "cancelled"; h.status = "cancelled"; }
      } else enqueueUnblock(d, h);
      h.updated = Date.now(); targets.push(h.target);
    }
    return targets;
  });
  for (const target of result) {
    abortFlights(f => f.account === account && (target.userId && f.userId === target.userId || f.handle === target.handle));
    if (target.userId) await forgetObserverUser(account, target.userId);
  }
  notify(); void drain();
  return { count: result.length, skipped: items.length - result.length };
}
/** Record one notification per successful block, not per status refresh or retry.
 * Historical records without these fields stay read when upgrading.
 */
function markTrashUnread(history) {
  if (!history.trashNotified) { history.trashNotified = true; history.trashUnread = true; }
}
function sessionFor(db, tabId, sessionId, account) {
  const s = db.sessions[tabId];
  if (!s || s.id !== sessionId || s.account !== account || !s.active || s.paused || s.stopped || db.settings.paused) throw new Error(t("ui_current_thread_task_is_paused_or_changed"));
  return s;
}
function cancelSession(db, sessionId) {
  for (const j of db.jobs) if (j.sessionId === sessionId && !j.manual && j.kind === "block" && (j.status === "pending" || j.status === "running" && !j.submitted)) {
    const owner = db.history.find(h => h.id === j.historyId);
    if (owner?.observerOwner || owner?.nameOwner) { owner.stanceOwner = false; owner.module = owner.observerOwner ? "observer" : "name"; j.module = owner.module; continue; }
    j.status = "cancelled";
    const h = db.history.find(h => h.id === j.historyId);
    if (h) { h.status = "cancelled"; h.updated = Date.now(); }
  }
}
function abortFlights(predicate) { for (const f of [...flights.values(), ...observerFlights.values()]) if (predicate(f)) f.controller.abort(); }

/** Resolve only observations made under this acting account. Unknown is not "not followed".
 * Session observations override older post snapshots, including results still in flight.
 */
function followingObservation(db, account, target) {
  let latest = target.followingAccount === account && typeof target.following === "boolean" ? target : null;
  const observation = db.observerFollowing?.[observerUserKey(account, target.userId)];
  if (observation && (!latest || observation.followingAt >= latest.followingAt)) latest = observation;
  for (const s of Object.values(db.sessions)) if (s.account === account) {
    for (const key of [target.userId && `id:${target.userId}`, `handle:${target.handle}`].filter(Boolean)) {
      const observed = s.following?.[key];
      if (observed && (!target.userId || !observed.userId || target.userId === observed.userId)
        && (!latest || observed.followingAt >= latest.followingAt)) latest = observed;
    }
  }
  return latest;
}
function followingStatus(db, account, target) { return followingObservation(db, account, target)?.following ?? null; }
function skipFollowing(db, account, target) { return db.settings.skipFollowing && followingStatus(db, account, target) !== false; }
/** Return true/false/null for followed/not protected/unknown. Batch readers may pass
 * a historyById Map from the same db snapshot to avoid repeated history scans.
 */
function jobFollowingStatus(db, job, historyById) {
  if (job.kind !== "block" || !(job.module === "observer" ? db.settings.observer?.skipFollowing : db.settings.skipFollowing)) return false;
  const history = historyById ? historyById.get(job.historyId) : db.history.find(h => h.id === job.historyId);
  return job.module === "observer" || history?.reason !== "author" ? followingStatus(db, job.account, job.target) : false;
}
function protectedFollowingJob(db, job) { return job.module === "name" ? observerExempt(job.target) || followingStatus(db, job.account, job.target) !== false : job.module === "observer" && observerExempt(job.target) || jobFollowingStatus(db, job) === true; }
function waitingFollowingJob(db, job, historyById) { return jobFollowingStatus(db, job, historyById) === null; }
// Whitelisted jobs can be cancelled immediately even when their relationship is unknown.
function runnableBlockJob(db, job) {
  return job.kind === "block" && !db.queueError && !db.settings.paused && !db.debugDryRun
    && (job.module !== "observer" || db.settings.observer?.enabled)
    && (job.module !== "name" || matchingNameRules(db.settings, job.target).length)
    && (!waitingFollowingJob(db, job) || isWhitelisted(db, job.target) || job.module === "observer" && observerExempt(job.target));
}
/** Cancel unsent comment blocks only. Already submitted requests cannot be recalled. */
function cancelFollowingJobs(db) {
  for (const j of db.jobs) if ((j.status === "pending" || j.status === "running" && !j.submitted) && protectedFollowingJob(db, j)) {
    j.status = "cancelled";
    const h = db.history.find(h => h.id === j.historyId);
    if (h) { h.status = "cancelled"; h.updated = Date.now(); }
  }
}
/** Remember bounded, account-scoped relationship evidence before classification/queue work. */
function observeFollowing(db, session, posts) {
  session.following ||= {};
  for (const p of posts) {
    if (p.followingAccount !== session.account || typeof p.following !== "boolean" || !p.followingAt) continue;
    const key = p.userId ? `id:${p.userId}` : `handle:${p.handle}`;
    const old = session.following[key];
    if (old && old.followingAt > p.followingAt) continue;
    const entry = { handle: p.handle, userId: p.userId, following: p.following, followingAt: p.followingAt };
    session.following[key] = entry;
    session.following[`handle:${p.handle}`] = entry;
    if (old && old.following !== p.following) {
      for (const s of Object.values(db.sessions)) if (s.account === session.account) {
        for (const [id, result] of Object.entries(s.results)) if (result.handle === p.handle) delete s.results[id];
        s.count = Object.keys(s.results).length;
      }
    }
    // Carry new evidence into durable jobs even if this tab later starts another task.
    for (const j of db.jobs) if (j.account === session.account && sameTarget(j.target, p)
      && (!j.target.userId || !p.userId || j.target.userId === p.userId) && !j.submitted) {
      if ((j.target.followingAt || 0) <= p.followingAt) Object.assign(j.target, { following: p.following, followingAccount: session.account, followingAt: p.followingAt });
    }
  }
  const entries = Object.entries(session.following);
  if (entries.length > 5000) session.following = Object.fromEntries(entries.sort((a, b) => b[1].followingAt - a[1].followingAt).slice(0, 5000));
  cancelFollowingJobs(db);
}

/** Enqueue an explicit user choice or validated model decision; deduplicate by account identity. */
function enqueueBlock(db, s, target, reply, decision, reason) {
  // Dry-run decisions never become jobs or real block history, even after debugging ends.
  if (db.debugDryRun) return null;
  const manual = reason === "manual";
  if (!manual && contentExcepted(db, s.account, s.root.id, reply || target)) return null;
  const observer = reason === "observer", nameRule = reason === "name_rule";
  const protectedFollowing = nameRule ? followingStatus(db, s.account, target) !== false : observer ? db.settings.observer?.skipFollowing && followingStatus(db, s.account, target) !== false : skipFollowing(db, s.account, target);
  if ((observer || nameRule) && observerExempt(target) || isWhitelisted(db, target) || target.handle === s.account || (reply && protectedFollowing) || (!manual && s.excluded.includes(target.handle))) return null;
  const existing = db.history.findLast(h => h.account === s.account && sameTarget(h.target, target));
  if (existing && !["unblocked", "cancelled"].includes(existing.status)) {
    if (nameRule) {
      existing.nameOwner = true;
      existing.nameRuleIds = [...new Set([...(existing.nameRuleIds || []), ...decision.nameRuleIds])];
      existing.nameRuleNames = { ...existing.nameRuleNames, ...decision.nameRuleNames };
      existing.nameRootIds = [...new Set([...(existing.nameRootIds || []), s.root.id])].slice(-100);
      existing.target.filterGrants = { ...existing.target.filterGrants, ...target.filterGrants };
      existing.target.name = target.name;
      for (const job of db.jobs) if (job.historyId === existing.id && !job.submitted) { job.target.name = target.name; job.target.filterGrants = existing.target.filterGrants; }
      for (const job of db.jobs) if (job.historyId === existing.id && job.kind === "block") job.nameAuthorizationRevoked = false;
    } else if (observer) {
      if (existing.module === "name") {
        existing.module = "observer";
        for (const job of db.jobs) if (job.historyId === existing.id && job.kind === "block" && !job.submitted) job.module = "observer";
      }
      existing.observerOwner = true;
      for (const job of db.jobs) if (job.historyId === existing.id && job.kind === "block") job.observerAuthorizationRevoked = false;
    }
    else {
      existing.stanceOwner = true;
      if (["observer", "name"].includes(existing.module)) {
        existing.module = "stance"; existing.root = { ...s.root, text: s.root.text.slice(0, 1500) }; existing.sessionId = s.id;
        existing.reply = reply ? { ...reply, text: reply.text.slice(0, 1500) } : null; existing.reason = reason; existing.decision = decision;
      }
      for (const job of db.jobs) if (job.historyId === existing.id && !job.submitted && job.kind === "block") { job.module = "stance"; job.manual ||= manual; job.sessionId = existing.sessionId; job.rootId = existing.root.id; }
    }
    return existing.id;
  }
  if (db.history.length >= 5000) throw new Error(t("ui_history_has_reached_5_000_records_export_and_clear_completed"));
  const relation = followingObservation(db, s.account, target);
  const h = { id: id(), account: s.account, target: { handle: target.handle, userId: target.userId || "", name: target.name,
    following: relation?.following ?? null, followingAccount: s.account, followingAt: relation?.followingAt || 0, ...(nameRule ? { filterGrants: target.filterGrants } : {}) }, root: { ...s.root, text: s.root.text.slice(0, 1500) },
    reply: reply ? { ...reply, text: reply.text.slice(0, 1500) } : null, decision, reason, module: nameRule ? "name" : observer ? "observer" : "stance", nameOwner: nameRule, nameRuleIds: nameRule ? decision.nameRuleIds : [], nameRuleNames: nameRule ? decision.nameRuleNames : {}, nameRootIds: nameRule ? [s.root.id] : [], observerOwner: observer, stanceOwner: !observer && !nameRule, sessionId: s.id, status: "pending", created: Date.now(), updated: Date.now(), error: "", owned: false };
  db.history.push(h);
  db.jobs.push({ id: id(), historyId: h.id, kind: "block", module: h.module, account: s.account, actorId: s.actorId || "", origin: s.origin || "https://x.com", target: h.target, tabId: s.tabId, sessionId: s.id, manual, rootId: s.root.id, status: "pending", created: Date.now(), submitted: false });
  if (reply && !manual) offerQuickUndo(s, h);
  return h.id;
}
function enqueueUnblock(db, h) {
  if (!h.owned) throw new Error(t("ui_this_extension_did_not_submit_the_block_so_it_cannot"));
  if (db.jobs.some(j => j.historyId === h.id && ["pending", "running"].includes(j.status))) throw new Error(t("ui_this_account_already_has_a_pending_action"));
  for (const s of Object.values(db.sessions)) if (s.account === h.account && !s.excluded.includes(h.target.handle)) s.excluded.push(h.target.handle);
  h.status = "undo_pending"; h.error = ""; h.updated = Date.now();
  db.jobs.push({ id: id(), historyId: h.id, kind: "unblock", account: h.account, target: h.target, status: "pending", created: Date.now(), submitted: false });
}

/** A task is one selected tweet under one acting account, even across repeated sessions. */
function taskScope(entry, account, rootId) { return !["observer", "name"].includes(entry.module) && entry.account === account && entry.root?.id === rootId; }

/** Compute a fresh undo preview from durable records; never trust IDs/counts supplied by the UI. */
function taskUndoPlan(db, account, rootId) {
  const rows = db.history.filter(h => taskScope(h, account, rootId));
  const sessions = Object.values(db.sessions).filter(s => taskScope(s, account, rootId));
  if (!rows.length && !sessions.length) throw new Error(t("ui_task_not_found_or_already_cleared"));
  const plan = { account, rootId, root: rows[0]?.root || sessions[0].root, ready: [], cancel: [], inFlight: [], existing: 0, review: 0, protected: 0, active: sessions.filter(s => !s.stopped).length };
  for (const h of rows) {
    if (h.observerOwner || h.nameOwner) { plan.protected++; continue; }
    // A later task may own the account's current relationship. Do not undo it through an older record.
    const latest = db.history.findLast(other => other.account === account && sameTarget(other.target, h.target));
    if (latest?.id !== h.id || h.status === "preexisting") { if (!["cancelled", "unblocked"].includes(h.status)) plan.protected++; continue; }
    const job = db.jobs.find(j => j.historyId === h.id && ["pending", "running"].includes(j.status));
    if (job?.kind === "block") {
      if (job.status === "running" && job.submitted) plan.inFlight.push(h.id);
      else plan.cancel.push(h.id);
    } else if (["undo_pending", "undo_running"].includes(h.status)) plan.existing++;
    else if (h.owned && ["submitted", "blocked", "undo_failed"].includes(h.status)) plan.ready.push(h.id);
    else if (["uncertain", "failed", "undo_failed", "running"].includes(h.status)) plan.review++;
  }
  return plan;
}
function taskUndoSummary(plan) {
  return { account: plan.account, rootId: plan.rootId, root: plan.root, ready: plan.ready.length, cancel: plan.cancel.length, inFlight: plan.inFlight.length, existing: plan.existing, review: plan.review, protected: plan.protected, active: plan.active };
}

/** Revoke obsolete observer authorization in the same transaction as a policy change.
 * Preserve independently authorized stance/manual jobs and already-sent requests.
 * Failed observer blocks also lose retry eligibility until new evidence authorizes them.
 */
function finishObserverRevocation(job, history) {
  if (!job.observerAuthorizationRevoked) return;
  if (history) history.observerOwner = false;
  if (history?.stanceOwner || job.manual) {
    job.module = "stance";
    if (history) history.module = "stance";
    return;
  }
  if (history?.nameOwner) { job.module = "name"; history.module = "name"; return; }
  job.status = "cancelled";
  if (history) { history.status = "cancelled"; history.updated = Date.now(); }
}
function invalidateObserverJobs(db) {
  const history = new Map(db.history.map(h => [h.id, h]));
  for (const j of db.jobs) {
    if (j.kind !== "block" || !["pending", "running", "uncertain", "failed"].includes(j.status)) continue;
    const h = history.get(j.historyId);
    if (j.module !== "observer" && !h?.observerOwner) continue;
    // Keep sent/unknown records visible for reconciliation, but remember that their
    // old observer policy can no longer authorize a future POST after that read.
    j.observerAuthorizationRevoked = true;
    if (j.submitted && (j.status !== "failed" || !j.resultKnown)) continue;
    finishObserverRevocation(j, h);
  }
}
// Appearance/budget changes do not revoke an already-authorized block.
const observerPolicyKeys = ["enabled", "mode", "reviewMinReplies", "reviewThreshold", "reviewConfidence", "scope", "threshold", "confidence", "minHits", "retentionDays", "skipFollowing", "prompt", "analysisRule", "reviewRule"];

/** Revoke a name rule without changing another module's independent authorization. */
function finishNameRevocation(job, history) {
  if (!job.nameAuthorizationRevoked) return;
  if (history) history.nameOwner = false;
  if (history?.stanceOwner) { job.module = "stance"; history.module = "stance"; return; }
  if (history?.observerOwner) { job.module = "observer"; history.module = "observer"; return; }
  job.status = "cancelled";
  if (history) { history.status = "cancelled"; history.updated = Date.now(); }
}
function invalidateNameJobs(db) {
  const records = new Map(db.history.map(h => [h.id, h]));
  for (const job of db.jobs) {
    const h = records.get(job.historyId);
    if (job.kind !== "block" || !h?.nameOwner || !["pending", "running", "failed", "uncertain"].includes(job.status)
      || matchingNameRules(db.settings, h.target).length) continue;
    job.nameAuthorizationRevoked = true;
    if (job.submitted && (job.status !== "failed" || !job.resultKnown)) continue;
    finishNameRevocation(job, h);
  }
}
/** Match only visible replies supplied by an X content script; no model/key/evidence required. */
async function applyNameRules(message, sender) {
  if (typeof message.displayName !== "string" || !message.displayName.trim() || message.displayName.length > 160) return { action: "skip" };
  const account = normalizeHandle(message.account), root = sanitizePost(message.root), reply = sanitizePost(message.reply);
  const parents = Array.isArray(message.ancestors) && message.ancestors.length <= 30 ? message.ancestors.map(sanitizePost) : [];
  const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
  reply.name = message.displayName.trim().slice(0, 80);
  const page = tab && isX(tab.url) && !tab.incognito ? new URL(tab.url) : null;
  if (!page || !(/^\/home\/?$/.test(page.pathname) || postId(tab.url) === root.id) || !reply.userId || reply.id === root.id || !reply.parentId || !validateThread(root, reply, parents)) return { action: "skip" };
  const before = await read(d => ({ settings: d.settings, whitelist: d.whitelist, contentExceptions: d.contentExceptions, observerFollowing: d.observerFollowing,
    sessions: Object.fromEntries(Object.entries(d.sessions).map(([key, session]) => [key, { account: session.account, following: session.following }])) }));
  if (contentExcepted(before, account, root.id, reply) || before.settings.paused || observerExempt(reply) || isWhitelisted(before, reply) || reply.handle === account) return { action: "skip" };
  if (followingStatus(before, account, reply) !== false) return { action: "skip" };
  const rules = getProcessingFilters(before.settings).filter(r => r.enabled);
  const revision = JSON.stringify(getProcessingFilters(before.settings));
  const target = { ...reply, name: message.displayName.trim(), hasLink: !!message.hasLink };
  const evaluation = await evaluateFilters(rules, target);
  if (!evaluation.errors.length && !evaluation.results.some(r => r.matched)) return { action: "keep" };
  const eventRevision = await requestKey({ filterRules: rules });
  const binding = evaluation.results.some(r => r.matched) ? await bindAccount(sender.tab.id, account) : null;
  // Navigation and policy edits during evaluation cannot authorize a stale action.
  const currentTab = await chrome.tabs.get(sender.tab.id).catch(() => null);
  if (currentTab?.url !== tab.url) return { action: "skip" };
  const result = await change(d => {
    if (contentExcepted(d, account, root.id, reply) || revision !== JSON.stringify(getProcessingFilters(d.settings)) || d.settings.paused || observerExempt(reply) || isWhitelisted(d, reply)
      || followingStatus(d, account, reply) !== false || d.nameRuleExclusions?.[`${account}:${reply.userId}`]
      || d.history.some(h => h.account === account && sameTarget(h.target, reply) && h.nameRuleWithdrawn)) return { action: "skip" };
    if (evaluation.errors.length) {
      d.filterErrors ||= {};
      for (const error of evaluation.errors) {
        const rule = [...d.settings.filterRules, ...(d.settings.subscriptionRules || [])].find(r => r.id === error.id);
        if (rule) {
          rule.enabled = false; d.filterErrors[rule.id] = error.reason;
          for (const source of d.filterSubscriptions || []) {
            const remote = source.rules.find(r => r.id === rule.id);
            if (remote) { remote.enabled = false; source.error = "update"; }
          }
        }
      }
      invalidateNameJobs(d);
      return { action: "skip" };
    }
    recordObserverRelations(d, account, [reply]);
    const matches = rules.filter(r => !d.filterRuleExclusions?.[`${account}:${reply.userId}`]?.includes(r.id) && evaluation.results.some(v => v.id === r.id && v.matched));
    if (!matches.length) return { action: "keep" };
    const blockRules = matches.filter(r => r.action === "block"), action = blockRules.length ? "block" : "mask";
    if (!d.debugDryRun) {
      d.filterEvents ||= [];
      const eventKey = `${account}:${reply.id}`;
      if (!d.filterEvents.some(e => e.key === eventKey && e.revision === eventRevision)) {
        d.filterEvents.push({ key: eventKey, revision: eventRevision, account, target: { handle: reply.handle, userId: reply.userId, name: reply.name },
          replyId: reply.id, rootId: root.id, action, ruleIds: matches.map(r => r.id), names: matches.map(r => r.name), created: Date.now() });
        d.filterEvents = d.filterEvents.slice(-1000);
      }
    }
    const names = matches.map(r => r.name);
    if (!blockRules.length) return { action: "mask", names };
    if (d.debugDryRun) return { action: "block", status: "simulated", names, id: `name-debug:${reply.userId}`, updated: Date.now() };
    reply.filterGrants = Object.fromEntries(blockRules.map(r => [r.id, filterStamp(r)]));
    const decision = { nameRuleIds: blockRules.map(r => r.id), nameRuleNames: Object.fromEntries(blockRules.map(r => [r.id, r.name])) };
    const historyId = enqueueBlock(d, { account, ...binding, tabId: sender.tab.id, id: `name:${account}:${root.id}`, root, excluded: [] }, reply, reply, decision, "name_rule");
    const h = d.history.find(h => h.id === historyId);
    return h ? { action: ["pending", "running", "submitted", "blocked"].includes(h.status) ? "block" : "keep", id: h.id, names, status: h.status, updated: h.updated } : { action: "skip" };
  });
  if (result.action !== "keep") notify();
  if (result.action === "block") void drain();
  return result;
}

const observerConfig = db => {
  const config = normalizeObserverSettings(db.settings.observer || {});
  return config.mode === "combined" ? { ...config, retentionDays: 30 } : config;
};
function clearlyNatural(decision, config) {
  const rule = getObserverRule(config);
  return observerBuiltinCategories(rule) && !rule.options.find(o => o.id === "human_like")?.block
    && decision?.label === "human_like" && decision.score >= config.reviewThreshold && decision.confidence >= config.reviewConfidence;
}
function accountSignalsAllowed(db, account, target, signals) {
  return !signals || Array.isArray(signals.references) && signals.references.every(r => Array.isArray(r.authors)
    && !contentExcepted(db, account, r.rootId, { ...target, id: r.replyId }) && !r.authors.some(p => isWhitelisted(db, p)));
}
function observerSummary(rows, config, fingerprint, db) {
  const reviewRows = rows.filter(e => !isWhitelisted(db, e) && !contentExcepted(db, e.account, e.rootId, { ...e, id: e.replyId })
    && (!e.reviewContext || ![e.reviewContext.root, e.reviewContext.reply, ...e.reviewContext.ancestors].some(p => isWhitelisted(db, p))))
    .map(e => e.accountReview && !accountSignalsAllowed(db, e.account, e, e.accountReview.accountSignals) ? { ...e, accountReview: null } : e);
  const summary = summarizeObserverEvidence(rows, config, fingerprint), review = eligibleAccountReview(reviewRows, config, fingerprint), latestReview = eligibleAccountReview(reviewRows, config, fingerprint, Date.now(), false);
  const collected = reviewRows.filter(e => !e.withdrawn && e.reviewContext && e.fingerprint === fingerprint && (!e.simulation || config.includeDryRun) && e.observedAt > Date.now() - config.retentionDays * 86400000);
  return { ...summary, collected: collected.length, collectedThreads: new Set(collected.map(e => e.rootId)).size,
    eligible: config.mode === "combined" ? !!review : summary.eligible,
    accountReview: latestReview ? { label: latestReview.decision.label, probabilities: latestReview.decision.probabilities, winningScore: latestReview.decision.score, score: latestReview.decision.spamScore, confidence: latestReview.decision.confidence, samples: latestReview.replyIds.length,
      dimensions: latestReview.accountSignals ? { profile: latestReview.accountSignals.profile?.bio !== null, activity: latestReview.accountSignals.activity } : null } : null };
}
async function observerFingerprint(db) {
  const config = observerConfig(db);
  return requestKey({ module: OBSERVER_VERSION, mode: config.mode, ...(config.mode === "combined" ? { collection: ACCOUNT_REVIEW_VERSION } : {}), model: db.settings.model, ...observerRuleIdentity(config) }, db.settings.endpoint);
}
function observerHistoryIndex(db) {
  const index = new Map();
  for (const h of db.history) if (h.target.userId && (h.module === "observer" || h.observerOwner)) index.set(observerUserKey(h.account, h.target.userId), h);
  return index;
}
function observerResult(entry, db, historyIndex = observerHistoryIndex(db), accountReview = null) {
  const config = observerConfig(db), h = historyIndex.get(entry.userKey);
  const protectedUser = observerExempt(entry) || isWhitelisted(db, entry) || config.skipFollowing && followingStatus(db, entry.account, entry) !== false;
  const active = config.enabled && !protectedUser && !entry.withdrawn;
  const status = !active ? "observing" : db.debugDryRun && observerSimulations.has(entry.userKey) ? "simulated" : h?.status || "observing";
  const suspicious = config.mode === "cumulative" && observerSuspicious(entry, config);
  return { replyId: entry.replyId, rootId: entry.rootId, userId: entry.userId, handle: entry.handle, label: entry.label, score: entry.score, probabilities: entry.probabilities, spamScore: entry.spamScore, confidence: entry.confidence, accountReview: active ? accountReview : null, suspicious, status,
    action: active && ["pending", "running", "submitted", "blocked", "simulated"].includes(status) ? "block" : "keep", historyId: active ? h?.id || null : null, dryRun: status === "simulated", excerpt: entry.excerpt, observedAt: entry.observedAt };
}
async function observerSnapshot(db) {
  const config = observerConfig(db), fingerprint = await observerFingerprint(db);
  const [entries, dailyUsed, collections] = await Promise.all([readObserverAll(), readObserverBudget(), readReplyCollections()]);
  const groups = new Map(), history = observerHistoryIndex(db);
  for (const e of entries) if (!e.withdrawn && e.fingerprint === fingerprint && e.observedAt > Date.now() - config.retentionDays * 86400000) {
    if (!groups.has(e.userKey)) groups.set(e.userKey, []); groups.get(e.userKey).push(e);
  }
  const accounts = [];
  for (const rows of groups.values()) {
    rows.sort((a, b) => b.observedAt - a.observedAt);
    const e = rows[0], summary = observerSummary(rows, { ...config, includeDryRun: !!db.debugDryRun }, fingerprint, db), h = history.get(e.userKey);
    if (db.debugDryRun) { if (summary.eligible) observerSimulations.add(e.userKey); else observerSimulations.delete(e.userKey); }
    const collection = collections.get(e.userKey);
    accounts.push({ account: e.account, userId: e.userId, handle: e.handle, name: e.name, blueVerified: e.blueVerified, status: h?.status || "observing", historyId: h?.id || null, owned: !!h?.owned, error: h?.error || "", snoozedUntil: db.observerSnoozedUntil?.[e.userKey] || 0, ...summary,
      collection: config.mode === "combined" && collection ? { status: collection.status === "fetching" && ![...observerFlights.values()].some(f => f.account === e.account && f.userId === e.userId) ? "unavailable" : collection.status, retryAt: collection.retryAt } : null,
      evidence: rows.filter(e => !e.error).slice(0, 30).map(({ replyId, rootId, url, label, labelName, customRule, score, confidence, excerpt, observedAt, replyText, replyTextIncomplete, reviewContext }) => ({ replyId, rootId, url, label, labelName, customRule, score, confidence, excerpt, observedAt,
        text: replyText ?? reviewContext?.reply?.text ?? excerpt,
        textIncomplete: replyText != null ? !!replyTextIncomplete : !reviewContext?.reply || !!reviewContext.reply.incomplete })) });
  }
  // Evidence can expire independently of an actual submitted block. Keep its undo entry.
  for (const [userKey, h] of history) if (!groups.has(userKey) && h.observerOwner && !["unblocked", "cancelled"].includes(h.status)) {
    accounts.push({ account: h.account, userId: h.target.userId, handle: h.target.handle, name: h.target.name, blueVerified: false, status: h.status, historyId: h.id, owned: !!h.owned, error: h.error || "", snoozedUntil: db.observerSnoozedUntil?.[userKey] || 0, hits: 0, valid: 0, threads: 0, hitRate: 0, eligible: false, evidence: [] });
  }
  return { accounts: accounts.sort((a, b) => (b.evidence[0]?.observedAt || 0) - (a.evidence[0]?.observedAt || 0)), dailyUsed };
}
function recordObserverRelations(db, account, posts) {
  db.observerFollowing ||= {};
  for (const p of posts) if (p.userId && p.followingAccount === account && typeof p.following === "boolean" && p.followingAt > 0) {
    const k = observerUserKey(account, p.userId), old = db.observerFollowing[k];
    if (!old || old.followingAt <= p.followingAt) db.observerFollowing[k] = { handle: p.handle, userId: p.userId, following: p.following, followingAccount: account, followingAt: p.followingAt };
    for (const job of db.jobs) if (job.account === account && job.target.userId === p.userId && !job.submitted && (job.target.followingAt || 0) <= p.followingAt) Object.assign(job.target, db.observerFollowing[k]);
  }
  const entries = Object.entries(db.observerFollowing);
  if (entries.length > 10000) db.observerFollowing = Object.fromEntries(entries.sort((a, b) => b[1].followingAt - a[1].followingAt).slice(0, 10000));
  cancelFollowingJobs(db);
}
function observerAllowed(db, account, root, reply, ancestors) {
  const config = observerConfig(db);
  return config.enabled && !contentExcepted(db, account, root.id, reply) && !analysisAlreadyHandled(db, account, reply)
    && !(db.observerSnoozedUntil?.[observerUserKey(account, reply.userId)] > Date.now()) && !matchingNameRules(db.settings, reply).length && !observerExempt(reply) && !db.settings.paused && !db.modelError && reply.userId && reply.handle !== account && reply.handle !== root.handle
    && !(config.scope === "blue" && reply.blueVerified !== true)
    && ![root, reply, ...ancestors].some(p => isWhitelisted(db, p))
    && !(config.skipFollowing && followingStatus(db, account, reply) !== false);
}
/** Combined-mode analysis. Runs outside the finalization lock. On first encounter,
 * supplement local observations with bounded recent replies, then make one model call.
 * Every fetched context is subject to the same whitelist and relationship protections.
 */
async function reviewObservedAccount({ db, account, root, reply, ancestors, binding, controller, fingerprint, epoch, policyRevision, dryRun, evidenceKey, secret }) {
  const config = observerConfig(db);
  if (config.mode !== "combined" || !secret) return;
  let rows = await readObserverUser(account, reply.userId);
  if (observerSummary(rows, { ...config, includeDryRun: dryRun }, fingerprint, db).eligible) return;
  const protectedContext = (d, e) => {
    const c = e.reviewContext;
    return !c || contentExcepted(d, account, e.rootId, { ...e, id: e.replyId }) || [c.root, c.reply, ...c.ancestors].some(p => isWhitelisted(d, p));
  };
  let samples = selectReviewSamples(rows.filter(e => !protectedContext(db, e)), { ...config, includeDryRun: dryRun }, fingerprint);
  const storedCollection = await readReplyCollection(observerUserKey(account, reply.userId));
  let signals = storedCollection?.epoch === epoch && storedCollection.accountSignals?.fingerprint === fingerprint
    && storedCollection.at > Date.now() - config.retentionDays * 86400000 && accountSignalsAllowed(db, account, reply, storedCollection.accountSignals) ? storedCollection.accountSignals : null;
  const latest = eligibleAccountReview(rows, { ...config, includeDryRun: dryRun }, fingerprint, Date.now(), false);
  // Reuse a recent negative result. After an hour, actively look for new material;
  // the model reservation still requires changed samples before charging again.
  const permitted = async () => {
    const current = await read();
    return !controller.signal.aborted && !!current.debugDryRun === dryRun && (current.observerPolicyRevision || 0) === policyRevision
      && observerAllowed(current, account, root, reply, ancestors) && await observerFingerprint(current) === fingerprint
      && await observerEpoch(account, reply.userId) === epoch && !samples.some(e => protectedContext(current, e)) && accountSignalsAllowed(current, account, reply, signals);
  };
  if (!await permitted()) return;
  if (latest && accountSignalsAllowed(db, account, reply, latest.accountSignals)) {
    if (!dryRun && clearlyNatural(latest.decision, config)) { await saveNormalAccount(account, reply, epoch); return; }
    if (Date.now() - latest.at < 3600000) return;
  }
  if ((!samples.length || !signals || latest) && await reserveReplyCollection(observerUserKey(account, reply.userId), epoch)) {
    notify();
    try {
      let candidates = [], fetchedProfile = null;
      const accept = async (contexts, profile) => {
        fetchedProfile = profile;
        const current = await read();
        if (!await permitted()) return true;
        // Check target relationships from the newest response, not a stale DOM flag.
        await change(d => recordObserverRelations(d, account, contexts.map(c => c.reply)));
        const fresh = await read();
        candidates = contexts.filter(c => observerAllowed(fresh, account, c.root, c.reply, c.ancestors));
        const local = rows.filter(e => e.reviewContext && !e.withdrawn && !e.error && (!e.simulation || dryRun) && e.observedAt > Date.now() - config.retentionDays * 86400000 && !protectedContext(current, e) && e.fingerprint === fingerprint);
        const ids = new Set([...local.map(e => e.replyId), ...candidates.map(c => c.reply.id)]);
        return ids.size >= config.reviewMinReplies;
      };
      await collectRecentReplies({ binding, userId: reply.userId, account, config, signal: controller.signal, permitted, accept });
      if (!await permitted()) return;
      const signalState = await read();
      candidates = candidates.filter(c => observerAllowed(signalState, account, c.root, c.reply, c.ancestors));
      signals = { ...summarizeAccountSignals(candidates, reply.userId, fetchedProfile), fingerprint };
      // Select available replies up to the limit; never require a distinct-root quota.
      const localContexts = rows.filter(e => !e.withdrawn && !e.error && (!e.simulation || dryRun) && e.observedAt > Date.now() - config.retentionDays * 86400000 && e.fingerprint === fingerprint && e.reviewContext && !protectedContext(db, e)).map(e => e.reviewContext);
      const uniqueContexts = new Map();
      for (const c of [...candidates, ...localContexts]) if (!uniqueContexts.has(c.reply.id)) uniqueContexts.set(c.reply.id, c);
      const selected = [...uniqueContexts.values()].slice(0, config.reviewMinReplies);
      const now = Date.now();
      for (const [index, c] of selected.entries()) {
        if (!await permitted()) return;
        if (rows.some(e => e.replyId === c.reply.id && e.reviewContext)) continue;
        const current = await read();
        if (!observerAllowed(current, account, c.root, c.reply, c.ancestors)) continue;
        await saveObserverEvidence({ key: observerEvidenceKey(account, c.reply.id, fingerprint), userKey: observerUserKey(account, reply.userId), replyKey: `${account}:${c.reply.id}`,
          account, userId: reply.userId, handle: c.reply.handle, name: c.reply.name, blueVerified: c.reply.blueVerified === true,
          replyId: c.reply.id, rootId: c.root.id, url: c.reply.url, excerpt: c.reply.text.slice(0, 160), replyText: c.reply.text, replyTextIncomplete: !!c.reply.incomplete, observedAt: now - index, fingerprint,
          following: c.reply.following, followingAccount: c.reply.followingAccount, followingAt: c.reply.followingAt,
          label: "collected", collected: true, simulation: dryRun, reviewContext: reviewContext(c.root, c.reply, c.ancestors) }, epoch, config.retentionDays);
      }
      rows = await readObserverUser(account, reply.userId);
      db = await read();
      samples = selectReviewSamples(rows.filter(e => !protectedContext(db, e)), { ...config, includeDryRun: dryRun }, fingerprint);
      await finishReplyCollection(observerUserKey(account, reply.userId), epoch, samples.length ? "ready" : "insufficient", Date.now() + 3600000, signals);
    } catch (error) {
      if (!controller.signal.aborted) await finishReplyCollection(observerUserKey(account, reply.userId), epoch,
        error.status === 429 ? "limited" : "unavailable", Math.max(Date.now() + 3600000, error.retryAt || 0));
      // A failed read is not AI evidence. Existing usable samples can still be analyzed.
      if (controller.signal.aborted || error.code === "REPLIES_CANCELLED" || [401, 403].includes(error.status) || !samples.length) return;
    } finally { notify(); }
  }
  if (!samples.length || !await permitted()) return;
  const flight = observerFlights.get(evidenceKey);
  if (flight) flight.contextHandles = [...new Set([...flight.contextHandles, ...samples.flatMap(e => [e.reviewContext.root, ...e.reviewContext.ancestors].map(p => p.handle))])];
  const replyIds = samples.map(e => e.replyId);
  if (!await reserveAccountReview(observerUserKey(account, reply.userId), epoch, fingerprint, replyIds)) return;
  try {
    const request = buildAccountReviewRequest(samples, db.settings.model, config, signals);
    const payload = await askJevCached(request, secret, controller.signal, p => parseObserverDecision(p, accountReviewConfig(config)), db.settings.cacheLimit, db.settings.endpoint, async () => {
      if (!await permitted()) throw Object.assign(new Error("Review cancelled"), { code: "OBSERVER_CANCELLED" });
      await reserveObserverBudget();
    });
    if (!await permitted()) return;
    const decision = parseObserverDecision(payload, accountReviewConfig(config));
    await saveAccountReview(evidenceKey, epoch, { version: ACCOUNT_REVIEW_VERSION, fingerprint, policyKey: reviewPolicyKey(config), replyIds, at: Date.now(), accountSignals: signals, decision });
    if (!dryRun && clearlyNatural(decision, config) && await permitted()) await saveNormalAccount(account, reply, epoch);
  } catch (error) {
    // A failed request retains collected text; the reservation prevents refresh retries.
    if (!controller.signal.aborted && !["OBSERVER_BUDGET", "OBSERVER_CANCELLED", "OBSERVER_REVIEW_TOO_LARGE"].includes(error.code)) {
      await change(d => { if ((d.observerPolicyRevision || 0) === policyRevision && (d.settings.analysisRevision || 0) === (db.settings.analysisRevision || 0)) d.modelError = error.message; }); notify();
    }
  }
}
/** Passive analysis still binds the acting account; a forged page handle never authorizes jobs. */
async function observeReply(message, sender) {
  const account = normalizeHandle(message.account), root = sanitizePost(message.root), reply = sanitizePost(message.reply);
  const ancestors = Array.isArray(message.ancestors) && message.ancestors.length <= 30 ? message.ancestors.map(sanitizePost) : [];
  // Match the page's eligibility rule: unread media does not veto textual replies,
  // including those beneath a media-only root or parent. Actual missing context still waits.
  if (!reply.userId || !validateThread(root, reply, ancestors) || !reply.text.trim() || [root, reply, ...ancestors].some(p => p.incomplete || !p.text.trim() && !p.hasMedia)) return { action: "skip", why: "missing-context" };
  let db = await read();
  if (!observerAllowed(db, account, root, reply, ancestors)) return { action: "skip", why: "protected" };
  if (observerConfig(db).mode === "combined" && await readNormalAccount(account, reply.userId)) return { action: "skip", why: "normal-account" };
  const binding = await bindAccount(sender.tab.id, account);
  await change(d => recordObserverRelations(d, account, [reply, ...ancestors]));
  const fingerprint = await observerFingerprint(db), evidenceKey = observerEvidenceKey(account, reply.id, fingerprint);
  if (observerFlights.has(evidenceKey)) return observerFlights.get(evidenceKey).promise;
  // A bounded flight pool prevents fast scrolling from producing an unbounded model queue.
  if ([...observerFlights.values(), ...flights.values()].some(f => f.account === account && (reply.userId ? f.userId === reply.userId : f.handle === reply.handle))) return { action: "skip", why: "account-busy" };
  if (observerFlights.size >= 2) return { action: "skip", why: "busy" };
  const controller = new AbortController();
  const run = (async () => {
    const config = observerConfig(db), epoch = await observerEpoch(account, reply.userId);
    let existing = await readObserverEvidence(evidenceKey);
    if (existing?.observedAt <= Date.now() - config.retentionDays * 86400000) existing = null;
    if (existing && (existing.error || existing.withdrawn || existing.simulation && !db.debugDryRun)) return { action: "skip", why: existing.error ? "previous-error" : "withdrawn" };
    db = await read();
    if (!observerAllowed(db, account, root, reply, ancestors) || controller.signal.aborted || await observerFingerprint(db) !== fingerprint) return { action: "skip", why: "config-changed" };
    if (!existing && config.mode === "cumulative") {
      const recent = await readObserverUser(account, reply.userId);
      if (recent.some(e => !e.withdrawn && e.fingerprint === fingerprint && e.observedAt > Date.now() - 60000)) return { action: "skip", why: "account-cooldown" };
    }
    const dryRun = !!db.debugDryRun;
    const policyRevision = db.observerPolicyRevision || 0;
    const request = config.mode === "cumulative" ? buildObserverRequest(root, reply, ancestors, db.settings.model, config) : null, secret = await key();
    if (!secret && config.mode === "cumulative") return { action: "skip", why: "missing-key" };
    const entry = { key: evidenceKey, userKey: observerUserKey(account, reply.userId), replyKey: `${account}:${reply.id}`, account, userId: reply.userId, handle: reply.handle, name: reply.name, blueVerified: reply.blueVerified === true, simulation: dryRun,
      replyId: reply.id, rootId: root.id, url: reply.url, excerpt: reply.text.slice(0, 160), replyText: reply.text, replyTextIncomplete: !!reply.incomplete, observedAt: Date.now(), fingerprint,
      following: reply.following, followingAccount: reply.followingAccount, followingAt: reply.followingAt };
    if (config.mode === "combined") entry.reviewContext = reviewContext(root, reply, ancestors);
    let decision = existing || (config.mode === "combined" ? { label: "collected", collected: true } : null);
    if (!existing && config.mode === "cumulative") try {
      const payload = await askJevCached(request, secret, controller.signal, answer => parseObserverDecision(answer, config), db.settings.cacheLimit, db.settings.endpoint, async () => {
        const current = await read();
        if (!observerAllowed(current, account, root, reply, ancestors) || controller.signal.aborted || await observerFingerprint(current) !== fingerprint) throw Object.assign(new Error("Observer observation cancelled"), { code: "OBSERVER_CANCELLED" });
        await reserveObserverBudget();
      });
      decision = parseObserverDecision(payload, config);
    } catch (error) {
      // Only a completed but malformed answer gets a per-reply tombstone. Connection,
      // authentication and rate-limit failures must remain retryable after Resume.
      if (!controller.signal.aborted && error.code === "JEV_INVALID_ANSWER") await saveObserverEvidence({ ...entry, label: "uncertain", score: 0, confidence: 0, error: true }, epoch, config.retentionDays);
      if (!controller.signal.aborted && !["OBSERVER_BUDGET", "OBSERVER_CANCELLED", "JEV_INVALID_ANSWER"].includes(error.code)) {
        await change(d => { if ((d.settings.analysisRevision || 0) === (db.settings.analysisRevision || 0) && (d.observerPolicyRevision || 0) === policyRevision) d.modelError = error.message; }); notify();
      }
      return { action: "skip", why: error.code === "OBSERVER_BUDGET" ? "daily-limit" : "analysis-error" };
    }
    if (config.mode === "combined") {
      const current = await read();
      if (!controller.signal.aborted && (current.observerPolicyRevision || 0) === policyRevision && observerAllowed(current, account, root, reply, ancestors)
        && !!current.debugDryRun === dryRun && await observerFingerprint(current) === fingerprint) {
        await saveObserverEvidence({ ...entry, ...decision }, epoch, config.retentionDays);
        await reviewObservedAccount({ db: current, account, root, reply, ancestors, binding, controller, fingerprint, epoch, policyRevision, dryRun, evidenceKey, secret });
      }
    }
    const finalize = observerFinalizing.then(async () => {
      let current = await read();
      if (!observerAllowed(current, account, root, reply, ancestors) || controller.signal.aborted || !!current.debugDryRun !== dryRun || (current.observerPolicyRevision || 0) !== policyRevision || await observerFingerprint(current) !== fingerprint) return { action: "skip", why: "config-changed" };
      const config = observerConfig(current);
      await saveObserverEvidence({ ...entry, ...decision }, epoch, config.retentionDays);
      const rows = await readObserverUser(account, reply.userId), summary = observerSummary(rows, { ...config, includeDryRun: dryRun }, fingerprint, current);
      const saved = rows.find(e => e.key === evidenceKey);
      if (!saved || saved.withdrawn || await observerEpoch(account, reply.userId) !== epoch) return { action: "skip", why: "withdrawn" };
      let simulated = false;
      if (dryRun && !summary.eligible) observerSimulations.delete(entry.userKey);
      if (summary.eligible) await change(d => {
        if (!observerAllowed(d, account, root, reply, ancestors) || controller.signal.aborted || !!d.debugDryRun !== dryRun
          || (d.observerPolicyRevision || 0) !== policyRevision || (d.settings.analysisRevision || 0) !== (db.settings.analysisRevision || 0)) return;
        if (d.debugDryRun) { simulated = true; observerSimulations.add(entry.userKey); return; }
        enqueueBlock(d, { account, ...binding, tabId: sender.tab.id, id: `observer:${account}:${reply.userId}`, root, excluded: [] }, reply, reply, { ...decision, accountReview: summary.accountReview, action: "block", module: "observer", fingerprint }, "observer");
      });
      current = await read();
      if (controller.signal.aborted || (current.observerPolicyRevision || 0) !== policyRevision) return { action: "skip", why: "config-changed" };
      await markObserverEvaluated(evidenceKey, epoch, policyRevision);
      notify(); void drain();
      if (Date.now() - observerCleanupAt > 3600000) {
        observerCleanupAt = Date.now(); void cleanObserverEvidence(config.retentionDays).catch(() => { observerCleanupAt = 0; });
      }
      return observerResult({ ...saved, dryRun: simulated }, current, observerHistoryIndex(current), summary.accountReview);
    });
    observerFinalizing = finalize.catch(() => {});
    return finalize;
  })();
  observerFlights.set(evidenceKey, { promise: run, controller, tabId: sender.tab.id, handle: reply.handle, account, replyId: reply.id, userId: reply.userId, contextHandles: [root.handle, ...ancestors.map(p => p.handle)] });
  try { return await run; } finally { observerFlights.delete(evidenceKey); }
}

async function classify(message, sender) {
  const tabId = sender.tab.id;
  const reply = sanitizePost(message.reply);
  const account = normalizeHandle(message.account);
  const flightKey = `${tabId}:${message.sessionId}:${reply.id}`;
  if (flights.has(flightKey)) return flights.get(flightKey).promise;
  if ([...flights.values(), ...observerFlights.values()].some(f => f.account === account && (reply.userId ? f.userId === reply.userId : f.handle === reply.handle))) return { action: "skip", why: "account-busy" };
  const controller = new AbortController();
  const promise = (async () => {
    let db = await read();
    let s = sessionFor(db, tabId, message.sessionId, account);
    if (await currentPostId(sender) !== s.root.id || reply.id === s.root.id || reply.conversationId !== s.root.conversationId) throw new Error(t("ui_reply_does_not_belong_to_the_selected_conversation"));
    if (s.sortRequired && !s.pageReady) return { action: "skip", why: "waiting-first-page" };
    if (analysisAlreadyHandled(db, account, reply) && !s.results[reply.id]) return { action: "skip", why: "already-handled" };
    if (contentExcepted(db, account, s.root.id, reply) || matchingNameRules(db.settings, reply).length || reply.handle === account || reply.handle === s.root.handle || isWhitelisted(db, reply) || skipFollowing(db, account, reply) || s.excluded.includes(reply.handle)) return { action: "skip" };
    if (db.modelError) throw new Error(db.modelError);
    if (!s.results[reply.id] && Object.keys(s.results).length >= 2000) throw new Error(t("ui_this_task_has_analyzed_2_000_replies_stop_and_start"));
    const ancestry = Array.isArray(message.ancestors) && message.ancestors.length <= 30 ? message.ancestors.map(sanitizePost) : [];
    if (!validateThread(s.root, reply, ancestry)) return { action: "skip", why: "missing-parent" };
    const parent = ancestry[0] || null;
    // Nested replies need their actual parent, not whichever card happens to be above them.
    if (!reply.parentId || (reply.parentId !== s.root.id && !parent)) return { action: "skip", why: "missing-parent" };
    if (!reply.text.trim()) return { action: "skip", why: "no-text" };
    const analysisConfig = db.settings;
    const revision = analysisConfig.analysisRevision || 0;
    const request = buildRequest(s.root, reply, parent, analysisConfig.model, analysisConfig.customPrompt, analysisConfig.analysisRule);
    const digest = await requestKey(request, analysisConfig.endpoint);
    const cached = s.results[reply.id];
    if (cached?.requestKey === digest && cached.analyzedAt > Date.now() - JEV_CACHE_TTL) {
      if (cached.error) return cached;
      // A stored score is reusable; an old keep/block action is not an immutable decision.
      // Rechecking policy must neither charge Jev nor bypass current whitelist/undo guards.
      return change(d => {
        const current = sessionFor(d, tabId, message.sessionId, account);
        if (contentExcepted(d, account, current.root.id, reply) || isWhitelisted(d, current.root) || isWhitelisted(d, reply) || skipFollowing(d, account, reply) || ancestry.some(p => isWhitelisted(d, p)) || current.excluded.includes(reply.handle) || controller.signal.aborted) return { action: "skip" };
        if ((d.settings.analysisRevision || 0) !== revision) return { action: "skip", why: "config-changed" };
        const result = { ...decideAction(cached, d.settings, current.root, reply, parent), analysisRevision: revision, contextComplete: ![current.root, reply, ...ancestry].some(p => p.incomplete || !p.text?.trim()), dryRun: !!d.debugDryRun, simulatedAt: d.debugDryRun ? Date.now() : 0, handle: reply.handle };
        if (result.action === "block") result.historyId = enqueueBlock(d, current, reply, reply, result, "supporter");
        // Preserve rubric text in durable block history, not in every transient session score.
        const { labelDescription, ...score } = result;
        current.results[reply.id] = score;
        return score;
      });
    }
    const flight = flights.get(flightKey);
    if (flight) flight.contextHandles = [s.root.handle, ...ancestry.map(p => p.handle)];
    const apiKey = await key();
    // Recheck after every await immediately before external transmission.
    db = await read(); s = sessionFor(db, tabId, message.sessionId, account);
    if (contentExcepted(db, account, s.root.id, reply) || isWhitelisted(db, s.root) || isWhitelisted(db, reply) || skipFollowing(db, account, reply) || ancestry.some(p => isWhitelisted(db, p)) || s.excluded.includes(reply.handle) || controller.signal.aborted) return { action: "skip" };
    if ((db.settings.analysisRevision || 0) !== revision) return { action: "skip", why: "config-changed" };
    if (analysisAlreadyHandled(db, account, reply)) return { action: "skip", why: "already-handled" };
    let result;
    let payload;
    try {
      payload = await askJevCached(request, apiKey, controller.signal,
        answer => parseDecision(answer, db.settings, s.root, reply, parent), db.settings.cacheLimit, analysisConfig.endpoint);
    }
    catch (e) {
      if (e.code === "JEV_INVALID_ANSWER" && !controller.signal.aborted) {
        return change(d => {
          const current = sessionFor(d, tabId, message.sessionId, account);
          if (controller.signal.aborted || (d.settings.analysisRevision || 0) !== revision || isWhitelisted(d, reply) || skipFollowing(d, account, reply) || current.excluded.includes(reply.handle)) return { action: "skip", why: "config-changed" };
          // No probability is invented, no action enqueued, and no bad answer enters the shared cache.
          // Persist a per-comment failure to prevent repeated charges on refresh in this task.
          const result = { action: "keep", label: "uncertain", support: null, confidence: null, error: e.message,
            model: request.model, promptVersion: STANCE_PROMPT_VERSION, handle: reply.handle, analyzedAt: Date.now(), requestKey: digest };
          if (!current.results[reply.id]) current.count++;
          current.results[reply.id] = result;
          return result;
        });
      }
      if (!controller.signal.aborted) { await change(d => { if ((d.settings.analysisRevision || 0) === revision) d.modelError = e.message; }); notify(); }
      throw e;
    }
    return await change(d => {
      const current = sessionFor(d, tabId, message.sessionId, account);
      if (contentExcepted(d, account, current.root.id, reply) || isWhitelisted(d, current.root) || isWhitelisted(d, reply) || skipFollowing(d, account, reply) || ancestry.some(p => isWhitelisted(d, p)) || current.excluded.includes(reply.handle) || controller.signal.aborted) return { action: "skip" };
      // A cached model answer must still pass today's thresholds and account protections.
      if ((d.settings.analysisRevision || 0) !== revision) return { action: "skip", why: "config-changed" };
      result = { ...parseDecision(payload, d.settings, current.root, reply, parent), analysisRevision: revision, contextComplete: ![current.root, reply, ...ancestry].some(p => p.incomplete || !p.text?.trim()), dryRun: !!d.debugDryRun, simulatedAt: d.debugDryRun ? Date.now() : 0 };
      if (result.action === "block") result.historyId = enqueueBlock(d, current, reply, reply, result, "supporter");
      if (!current.results[reply.id]) current.count++;
      const { labelDescription, ...score } = result;
      current.results[reply.id] = { ...score, handle: reply.handle, analyzedAt: payload.cacheCreatedAt, requestKey: digest };
      return current.results[reply.id];
    });
  })();
  flights.set(flightKey, { promise, controller, tabId, account, replyId: reply.id, userId: reply.userId, sessionId: message.sessionId, handle: reply.handle, parentHandle: message.parent?.handle });
  try { const result = await promise; notify(); void drain(); return result; } finally { flights.delete(flightKey); }
}

async function findActionTab(job) {
  const tabs = await chrome.tabs.query({ url: X_URLS });
  for (const tab of tabs) {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "GET_VIEWER" }).catch(() => null);
    if (result?.account === job.account) return tab.id;
  }
  return null;
}
/** Bind the visible account to a stable cookie account ID once, while the user activates a task. */
async function bindAccount(tabId, account) {
  const tab = await chrome.tabs.get(tabId);
  if (!isX(tab.url) || tab.incognito) throw new Error(t("ui_start_from_a_signed_in_x_page_in_a_regular"));
  const origin = new URL(tab.url).origin;
  const before = await xSession(origin);
  const visible = await chrome.tabs.sendMessage(tabId, { type: "GET_VIEWER" });
  const after = await xSession(origin);
  if (visible?.account !== account || before.actorId !== after.actorId) throw new Error(t("ui_account_changed_start_the_task_again"));
  return { actorId: after.actorId, origin };
}

/** Only unblocking/reconciliation still use a page adapter; block jobs are worker-owned. */
async function permit(jobId, sender, mark, baseline) {
  return await change(d => {
    const j = d.jobs.find(j => j.id === jobId);
    if (!j || j.status !== "running" || j.actionTab !== sender.tab.id || (mark && j.submitted)) return false;
    if (j.kind !== "unblock") return false;
    if (mark) {
      if (!baseline || !numericId(baseline.userId) || typeof baseline.blocking !== "boolean" || normalizeHandle(baseline.handle) !== j.target.handle) throw new Error(t("ui_account_verification_failed"));
      if (j.target.userId && j.target.userId !== baseline.userId) throw new Error(t("ui_the_username_now_belongs_to_a_different_account_action_stopped"));
      j.target.userId = baseline.userId;
      j.submitted = true;
      j.wasBlocked = baseline.blocking;
      const h = d.history.find(h => h.id === j.historyId);
      if (h) { h.target.userId = baseline.userId; h.wasBlocked = baseline.blocking; }
    }
    return true;
  });
}

/** One persistent global queue. Never automatically replay a request with an unknown result. */
async function drain() {
  if (draining) return;
  draining = true;
  // Messages, cookie events and alarms all enter here. Keep only one continuation timer.
  clearTimeout(drainTimer); drainTimer = undefined;
  try {
    let db = await read();
    if (Date.now() < db.nextActionAt) return;
    const job = db.jobs.find(j => j.status === "pending" && j.kind === "unblock")
      || db.jobs.find(j => j.status === "pending" && runnableBlockJob(db, j));
    if (!job) return;
    if (job.kind === "block" && (isWhitelisted(db, job.target) || protectedFollowingJob(db, job))) {
      await change(d => { const j = d.jobs.find(x => x.id === job.id); j.status = "cancelled"; const h = d.history.find(x => x.id === j.historyId); if (h) h.status = "cancelled"; });
      notify(); return;
    }
    let tabId = null, login;
    if (job.kind === "block") {
      try {
        // Upgrade old pending jobs once. New jobs already contain this binding and need no tab.
        if (!job.actorId) {
          const legacyTab = await findActionTab(job);
          if (legacyTab === null) throw new Error(t("ui_open_x_signed_in_as_once_to_connect_this_older", job.account));
          Object.assign(job, await bindAccount(legacyTab, job.account));
          await change(d => { const j = d.jobs.find(j => j.id === job.id); if (j) { j.actorId = job.actorId; j.origin = job.origin; } });
        }
        login = await xSession(job.origin);
        if (login.actorId !== job.actorId) throw new Error(t("ui_queue_waiting_for_to_sign_in_no_other_account_will", job.account));
      } catch (e) { await change(d => { d.queueNotice = e.message; }); notify(); return; }
    } else {
      tabId = await findActionTab(job);
      if (tabId === null) { await change(d => { d.queueNotice = t("ui_to_unblock_open_any_x_page_signed_in_as", job.account); }); notify(); return; }
    }
    await change(d => {
      const j = d.jobs.find(x => x.id === job.id);
      if (!j || j.status !== "pending") return;
      j.status = "running"; j.actionTab = tabId;
      d.queueNotice = "";
      const h = d.history.find(x => x.id === j.historyId);
      if (h) { h.status = j.kind === "block" ? "running" : "undo_running"; h.updated = Date.now(); }
    });
    db = await read();
    if (db.jobs.find(j => j.id === job.id)?.status !== "running") return;
    notify();
    let result;
    if (job.kind === "block") {
      const allowed = await change(d => {
        const j = d.jobs.find(j => j.id === job.id);
        if (!j || j.status !== "running" || j.submitted) return false;
        if (isWhitelisted(d, j.target) || protectedFollowingJob(d, j)) {
          j.status = "cancelled"; const h = d.history.find(h => h.id === j.historyId); if (h) h.status = "cancelled";
          return false;
        }
        if (waitingFollowingJob(d, j) || d.settings.paused || d.queueError || d.debugDryRun || j.module === "observer" && !d.settings.observer?.enabled || j.module === "name" && !matchingNameRules(d.settings, j.target).length) {
          j.status = "pending"; const h = d.history.find(h => h.id === j.historyId); if (h) h.status = "pending";
          return false;
        }
        j.submitted = true; j.transport = "worker"; j.resultKnown = false;
        return true;
      });
      if (!allowed) { notify(); return; }
      result = await postBlock(job.target, login);
    } else {
      try { result = await chrome.tabs.sendMessage(tabId, { type: "EXECUTE_ACTION", job: { ...job, actionTab: tabId } }); }
      catch { result = { ok: false, uncertain: true, error: t("ui_page_closed_or_connection_lost_verify_the_outcome") }; }
    }
    await change(d => {
      const j = d.jobs.find(x => x.id === job.id);
      const h = d.history.find(x => x.id === job.historyId);
      if (!j || !h) return;
      h.updated = Date.now();
      d.nextActionAt = Date.now() + Math.max(2500, Number(result?.retryAfterMs) || 0);
      if (result?.ok) {
        j.status = "done"; j.resultKnown = true; h.error = "";
        if (result.target?.userId) h.target.userId = result.target.userId;
        if (job.kind === "unblock") h.status = "unblocked";
        else if (result.preexisting) { h.status = "preexisting"; h.owned = false; }
        else { h.status = result.accepted ? "submitted" : "blocked"; h.owned = true; h.verification = result.accepted ? "http-only" : "relationship"; markTrashUnread(h); }
      } else if (result?.cancelled) { j.status = "cancelled"; h.status = job.kind === "unblock" ? "blocked" : "cancelled"; }
      else {
        const uncertain = result?.uncertain && j.submitted;
        j.resultKnown = !uncertain;
        j.status = uncertain ? "uncertain" : "failed";
        h.status = uncertain ? "uncertain" : job.kind === "unblock" ? "undo_failed" : "failed";
        h.error = String(result?.error || t("ui_no_verifiable_result_received")).slice(0, 300); j.error = h.error;
        if (job.kind === "block" && j.status === "failed") { finishObserverRevocation(j, h); finishNameRevocation(j, h); }
        // A failed account does not hold up the remaining queue. Auth/rate-limit errors do.
        if (job.kind === "unblock" || result?.pauseQueue) d.queueError = h.error;
      }
      // A task-wide undo can race with an already-sent POST. Wait for its response before undoing,
      // otherwise a late block response could re-block an account after the undo completed.
      if (job.kind === "block" && h.undoRequested && h.owned && ["submitted", "blocked"].includes(h.status)) enqueueUnblock(d, h);
    });
    notify();
  } catch (e) { console.warn("block s.b. queue:", e.message); }
  finally {
    try {
      // Hold the mutex through this read: another wakeup must not install a second timer.
      // Alarms recover after worker suspension; the timer only improves foreground latency.
      const db = await read();
      if (db.jobs.some(j => j.status === "pending" && (j.kind === "unblock" || runnableBlockJob(db, j)))) {
        drainTimer = setTimeout(() => void drain(), db.queueNotice ? 30000 : Math.min(30000, Math.max(2500, db.nextActionAt - Date.now())));
        // Node's mocked worker should exit naturally; Chrome returns a numeric timer handle.
        drainTimer.unref?.();
      }
    } catch { console.warn(t("ui_block_s_b_cannot_read_queue_will_retry_on_next")); }
    finally { draining = false; }
  }
}

async function handle(message, sender) {
  const ui = sender.url?.startsWith(extensionOrigin);
  const web = !!sender.tab && isX(sender.url);
  if (sender.id !== chrome.runtime.id || (!ui && !web)) throw new Error(t("ui_invalid_request_source"));
  const type = message?.type;
  if (type === "SNAPSHOT") return snapshot(sender, message.account, message.view);
  if (type === "LEGAL_ACCEPT") {
    if (!ui || message.version !== LEGAL_VERSION || message.accepted !== true) throw new Error(t("ui_invalid_request_source"));
    const accepted = await change(d => {
      d.legalAcceptance = { version: LEGAL_VERSION, license: "AGPL-3.0-only", acceptedAt: Date.now() };
      d.onboardingRequired = false; return d.legalAcceptance;
    }); notify(); return accepted;
  }
  if (["SUBSCRIPTION_PREVIEW", "SUBSCRIPTION_ADD", "SUBSCRIPTION_REFRESH", "SUBSCRIPTION_EDIT", "SUBSCRIPTION_REMOVE"].includes(type)) {
    if (!ui) throw new Error(t("ui_invalid_request_source"));
    try {
      if (type === "SUBSCRIPTION_PREVIEW") return await subscriptions.preview(message.url);
      if (type === "SUBSCRIPTION_ADD") return await subscriptions.add(message.token, message.autoUpdate);
      if (type === "SUBSCRIPTION_REFRESH") return await subscriptions.refresh(message.id);
      return await subscriptions.edit(message.id, message.autoUpdate, type === "SUBSCRIPTION_REMOVE");
    } catch { throw new Error(t("ui_subscription_failed")); }
  }
  if (type === "QUICK_UNDO") {
    if (!web || sender.frameId !== 0) throw new Error(t("ui_invalid_request_source"));
    return quickUndo(message, sender);
  }
  if (type === "READ_TRASH") {
    if (!web || !Array.isArray(message.ids) || message.ids.length > 5000 || message.ids.some(id => typeof id !== "string" || id.length > 80)) throw new Error(t("ui_invalid_request_source"));
    const account = normalizeHandle(message.account);
    const visible = await chrome.tabs.sendMessage(sender.tab.id, { type: "GET_VIEWER" });
    if (visible?.account !== account) throw new Error(t("ui_account_changed_start_the_task_again"));
    const ids = new Set(message.ids);
    // Acknowledge only records shown at click time. A later queue completion stays unread.
    await change(d => { for (const h of d.history) if (h.account === account && ids.has(h.id)) h.trashUnread = false; });
    notify(); return true;
  }
  if (type === "PREVIEW_FILTER") {
    if (!ui) throw new Error(t("ui_invalid_request_source"));
    let rules;
    try { rules = normalizeFilters([message.rule]); } catch (e) { throw new Error(t("ui_filter_invalid", e.message)); }
    const value = message.sample || {};
    const target = { name: String(value.name || "").slice(0, 160), handle: String(value.handle || "").replace(/^@/, "").slice(0, 15),
      text: String(value.text || "").slice(0, 14000), blueVerified: value.blueVerified === true, hasLink: value.hasLink === true, hasMedia: value.hasMedia === true };
    return evaluateFilters(rules, target);
  }
  if (type === "MATCH_NAME_RULES") { if (!web) throw new Error(t("ui_invalid_request_source")); return applyNameRules(message, sender); }
  if (type === "OBSERVE_REPLY") { if (!web) throw new Error(t("ui_invalid_request_source")); return observeReply(message, sender); }
  if (type === "OBSERVER_DECISIONS") {
    if (!web || !Array.isArray(message.replyIds) || message.replyIds.length > 100) throw new Error(t("ui_invalid_request_source"));
    const account = normalizeHandle(message.account);
    await bindAccount(sender.tab.id, account);
    const db = await read(), fingerprint = await observerFingerprint(db), config = observerConfig(db);
    const rows = await readObserverReplies(account, message.replyIds.map(numericId).filter(Boolean)), history = observerHistoryIndex(db);
    const accountReviews = new Map();
    if (db.debugDryRun || config.mode === "combined") {
      // Recover derived preview state after MV3 suspension; old simulations never authorize
      // real jobs, and withdrawn/normal evidence can remove an earlier simulated result.
      const users = new Map(rows.map(e => [e.userKey, e]));
      await Promise.all([...users.values()].map(async e => {
        const all = await readObserverUser(account, e.userId), summary = observerSummary(all, { ...config, includeDryRun: true }, fingerprint, db);
        accountReviews.set(e.userKey, summary.accountReview);
        if (db.debugDryRun) { if (summary.eligible) observerSimulations.add(e.userKey); else observerSimulations.delete(e.userKey); }
      }));
    }
    return rows.filter(e => !e.error && !e.withdrawn && (!e.simulation || db.debugDryRun) && (e.policyRevision || 0) === (db.observerPolicyRevision || 0) && e.fingerprint === fingerprint && e.observedAt > Date.now() - config.retentionDays * 86400000 && (!message.rootId || e.rootId === numericId(message.rootId))).map(e => observerResult(e, db, history, accountReviews.get(e.userKey)));
  }
  if (type === "OBSERVER_RELATIONSHIPS") {
    if (!web || !Array.isArray(message.posts) || message.posts.length > 40) throw new Error(t("ui_invalid_request_source"));
    const account = normalizeHandle(message.account), posts = message.posts.map(sanitizePost);
    await bindAccount(sender.tab.id, account);
    await change(d => recordObserverRelations(d, account, posts));
    const db = await read();
    if (observerConfig(db).skipFollowing) abortFlights(f => f.account === account && posts.some(p => p.userId === f.userId && p.following === true));
    notify(); void drain(); return true;
  }
  if (type === "OBSERVER_NORMAL_LIST") {
    if (!ui) throw new Error(t("ui_use_the_management_panel_for_this_action"));
    return (await listNormalAccounts()).map(({ key, ...row }) => row);
  }
  if (type === "OBSERVER_NORMAL_REMOVE") {
    if (!ui) throw new Error(t("ui_use_the_management_panel_for_this_action"));
    const account = normalizeHandle(message.account), userId = numericId(message.userId);
    if (!userId) throw new Error(t("ui_account_verification_failed"));
    abortFlights(f => f.account === account && f.userId === userId);
    await removeNormalAccount(account, userId);
    await change(d => { d.observerPolicyRevision = (d.observerPolicyRevision || 0) + 1; });
    notify(); return true;
  }
  if (type === "OBSERVER_FORGET") {
    if (!ui) throw new Error(t("ui_use_the_management_panel_for_this_action"));
    const account = normalizeHandle(message.account), userId = numericId(message.userId);
    if (!userId) throw new Error(t("ui_account_verification_failed"));
    abortFlights(f => f.account === account && f.userId === userId);
    await forgetObserverUser(account, userId);
    observerSimulations.delete(observerUserKey(account, userId));
    await change(d => {
      for (const h of d.history) if (h.account === account && h.target.userId === userId) h.observerOwner = false;
      for (const j of d.jobs) if (j.module === "observer" && j.account === account && j.target.userId === userId && !j.submitted && ["pending", "running"].includes(j.status)) {
        const h = d.history.find(h => h.id === j.historyId); if (h?.stanceOwner) continue;
        j.status = "cancelled"; if (h) h.status = "cancelled";
      }
    }); notify(); return true;
  }
  if (type === "DEBUG_DRY_RUN") {
    if (!web || typeof message.enabled !== "boolean") throw new Error(t("ui_invalid_request_source"));
    await change(d => {
      if (!!d.debugDryRun === message.enabled) return;
      d.debugDryRun = message.enabled;
      for (const s of Object.values(d.sessions)) {
        // Do not turn a simulated result into a real action when the guard is removed.
        if (!message.enabled && s.dryRun) { s.active = false; s.stopped = true; }
        s.dryRun = message.enabled; s.results = {}; s.count = 0;
      }
    });
    abortFlights(() => true);
    observerSimulations.clear();
    notify(); void drain(); return { enabled: !!(await read()).debugDryRun };
  }
  if (type === "THREAD_CONTEXT") {
    if (!web || !Array.isArray(message.posts) || message.posts.length > 40 || !Array.isArray(message.missingIds) || message.missingIds.length > 40) throw new Error(t("ui_invalid_context_request"));
    const account = normalizeHandle(message.account), db = await read(), s = db.sessions[sender.tab.id];
    if (!s || s.id !== message.sessionId || s.account !== account || s.stopped || await currentPostId(sender) !== s.root.id) throw new Error(t("ui_thread_task_changed"));
    const posts = message.posts.map(sanitizePost).filter(p => p.conversationId === s.root.conversationId && !isWhitelisted(db, p));
    await change(d => {
      const current = d.sessions[sender.tab.id];
      if (current?.id === s.id && current.account === account && !current.stopped) observeFollowing(d, current, posts);
    });
    notify();
    // Fresh relationship evidence can release legacy jobs without a page restart.
    void drain();
    const written = new Set(posts.map(p => p.id));
    const ids = [...new Set(message.missingIds.map(numericId).filter(id => id && !written.has(id)))];
    const result = await syncThreadContext(account, s.root.id, posts, ids);
    const current = await read(), session = current.sessions[sender.tab.id];
    if (session?.id !== s.id || session.account !== account || session.stopped || await currentPostId(sender) !== s.root.id) return [];
    return result.filter(p => p.conversationId === session.root.conversationId && !isWhitelisted(current, p));
  }
  if (type === "SETTINGS_EFFECT_PREVIEW") {
    if (!ui || !["observer", "stance"].includes(message.module)) throw new Error(t("ui_invalid_request_source"));
    const db = await read();
    if (message.module === "stance") {
      const allowed = ["preset", "high", "confidence", "skipFollowing", "maskEnabled", "maskThreshold", "autoLoadDefault"];
      const patch = Object.fromEntries(Object.entries(message.value || {}).filter(([key]) => allowed.includes(key)));
      const config = updateSettings(db.settings, patch);
      const sessions = Object.values(db.sessions).map(session => ({ ...session, results: Object.fromEntries(Object.entries(session.results || {}).filter(([replyId, result]) => {
        const target = { id: replyId, handle: result.handle, userId: session.following?.[`handle:${result.handle}`]?.userId || "" };
        return !isWhitelisted(db, target) && !contentExcepted(db, session.account, session.root.id, target)
          && !(config.skipFollowing && followingStatus(db, session.account, target) !== false);
      })) }));
      return previewStance(db.settings, config, sessions);
    }
    const config = normalizeObserverSettings(message.value, observerConfig(db));
    // Only threshold/cumulative changes can reuse today's evidence; never relabel with a different rubric.
    if (JSON.stringify(observerRuleIdentity(config)) !== JSON.stringify(observerRuleIdentity(observerConfig(db)))) return { available: false, reason: "stale-draft" };
    const fingerprint = await observerFingerprint(db), all = await readObserverAll(), groups = new Map();
    for (const e of all) if (!e.withdrawn && !e.error && !e.simulation && e.fingerprint === fingerprint
      && e.observedAt > Date.now() - Math.max(config.retentionDays, observerConfig(db).retentionDays) * 86400000 && !isWhitelisted(db, e)
      && !contentExcepted(db, e.account, e.rootId, { ...e, id: e.replyId })
      && !(db.observerSnoozedUntil?.[e.userKey] > Date.now())) {
      if (!groups.has(e.userKey)) groups.set(e.userKey, []); groups.get(e.userKey).push(e);
    }
    let total = 0, matched = 0, blocked = 0, changed = 0;
    for (const entries of groups.values()) {
      const eligibleRows = policy => entries.filter(e => !(policy.scope === "blue" && !e.blueVerified)
        && !(policy.skipFollowing && followingStatus(db, e.account, e) !== false));
      const before = summarizeObserverEvidence(eligibleRows(observerConfig(db)), observerConfig(db), fingerprint), after = summarizeObserverEvidence(eligibleRows(config), config, fingerprint);
      total += after.valid; matched += after.hits; blocked += after.eligible; changed += before.eligible !== after.eligible;
    }
    return { module: "observer", available: groups.size > 0, total, matched, blocked, masked: config.mask ? matched : 0, changed,
      ...(groups.size ? {} : { reason: "no-current-results" }) };
  }
  if (type === "CLEAR_JEV_CACHE") {
    if (!ui) throw new Error(t("ui_invalid_request_source"));
    return { cleared: await clearJevCache() };
  }
  if (type === "KEEP_CONTENT" || type === "OPEN_FILTER_FROM_REPLY") {
    if (!web || sender.frameId !== 0) throw new Error(t("ui_invalid_request_source"));
    const account = normalizeHandle(message.account), rootId = numericId(message.rootId), reply = sanitizePost(message.reply);
    if (!rootId || !reply.id || reply.id === rootId || !reply.parentId || await currentPostId(sender) !== rootId) throw new Error(t("ui_thread_changed_try_again"));
    const root = sanitizePost(message.root), parents = Array.isArray(message.ancestors) && message.ancestors.length <= 30 ? message.ancestors.map(sanitizePost) : [];
    if (root.id !== rootId || !validateThread(root, reply, parents)) throw new Error(t("ui_thread_changed_try_again"));
    const visible = await chrome.tabs.sendMessage(sender.tab.id, { type: "GET_VIEWER" });
    if (visible?.account !== account || await currentPostId(sender) !== rootId) throw new Error(t("ui_account_changed_start_the_task_again"));
    if (type === "OPEN_FILTER_FROM_REPLY") {
      const field = message.field === "text" ? "text" : "name";
      const value = field === "text" ? String(message.value || reply.text).slice(0, 512) : String(reply.name || "").slice(0, 160);
      if (!value.trim()) throw new Error(t("ui_filter_seed_empty"));
      const token = id(), now = Date.now();
      for (const [key, entry] of filterSeeds) if (entry.expires <= now) filterSeeds.delete(key);
      filterSeeds.set(token, { field, value, expires: now + 300000 });
      while (filterSeeds.size > 20) filterSeeds.delete(filterSeeds.keys().next().value);
      await chrome.tabs.create({ url: chrome.runtime.getURL(`src/manager/manager.html?tab=name-rules&seed=${token}`) });
      return true;
    }
    if (!["reply", "thread-user", "clear"].includes(message.scope)) throw new Error(t("ui_invalid_request_source"));
    const result = await change(d => {
      if (message.scope === "clear") { d.contentExceptions = (d.contentExceptions || []).filter(e => !(e.account === account && e.rootId === rootId && (e.replyId === reply.id || e.scope === "thread-user" && sameTarget(e, reply)))); return { cancelled: 0 }; }
      addContentException(d, account, rootId, reply, message.scope);
      let cancelled = 0;
      for (const j of d.jobs) {
        const h = d.history.find(h => h.id === j.historyId);
        if (j.kind !== "block" || j.manual || j.submitted || !["pending", "running"].includes(j.status) || j.account !== account || j.rootId !== rootId
          || !h || !contentExcepted(d, account, rootId, h.reply || h.target)
          || [h.stanceOwner, h.observerOwner, h.nameOwner].filter(Boolean).length > 1 || h.nameRootIds?.some(r => r !== rootId)) continue;
        j.status = "cancelled"; h.status = "cancelled"; h.updated = Date.now(); cancelled++;
      }
      return { cancelled };
    });
    if (message.scope !== "clear") abortFlights(f => f.account === account && (message.scope === "thread-user" ? f.userId === reply.userId || f.handle === reply.handle : f.replyId === reply.id));
    notify(); return result;
  }
  if (type === "FILTER_SEED_GET") {
    if (!ui || new URL(sender.url).pathname !== "/src/manager/manager.html") throw new Error(t("ui_invalid_request_source"));
    const seed = filterSeeds.get(message.token); filterSeeds.delete(message.token);
    if (!seed || seed.expires <= Date.now()) return null;
    return { field: seed.field, value: seed.value };
  }
  if (type === "OPEN_MANAGER") { await chrome.tabs.create({ url: chrome.runtime.getURL("src/manager/manager.html") }); return true; }
  if (["RULE_CONFIG", "SAVE_RULE_CONFIG", "OPEN_RULE_EDITOR", "SAVE_SETTINGS", "SAVE_MODEL_CONFIG", "SAVE_KEY", "REMOVE_KEY", "UNDO", "TASK_UNDO_PREVIEW", "UNDO_TASK", "RETRY_JOB", "RECONCILE", "CLEAR_FINISHED", "EXPORT"].includes(type) && !ui) throw new Error(t("ui_use_the_management_panel_for_this_action"));
  if (type === "OPEN_RULE_EDITOR") {
    const path = message.module === "observer" ? "src/manager/observer-rules.html" : "src/manager/rules.html";
    await chrome.tabs.create({ url: chrome.runtime.getURL(path) + (message.module === "observer" ? `?mode=${message.mode === "combined" ? "combined" : "cumulative"}` : "") }); return true;
  }
  if (type === "RULE_CONFIG") {
    const db = await read(), { settings } = db;
    if (message.module === "observer") {
      const config = observerConfig(db);
      return { rule: message.mode === "combined" ? getReviewRule(config) : getObserverRule({ ...config, mode: "cumulative" }), revision: db.observerEditorRevision ?? db.observerPolicyRevision ?? 0, model: settings.model, language: settings.language || "auto" };
    }
    return { rule: getAnalysisRule(settings), revision: settings.analysisRevision || 0, model: settings.model, language: settings.language || "auto" };
  }
  if (type === "SAVE_RULE_CONFIG") {
    if (message.module === "observer") {
      // Only the rule changes here. Thresholds and cumulative policy belong to settings.
      const combined = message.mode === "combined";
      const rule = combined ? normalizeReviewRule(message.rule) : normalizeObserverRule(message.rule);
      let activeChanged = false;
      const revision = await change(d => {
        if (!Number.isInteger(message.revision) || message.revision !== (d.observerEditorRevision ?? d.observerPolicyRevision ?? 0)) throw new Error(t("ui_settings_changed_in_another_window_copy_your_draft_then_load"));
        const current = observerConfig(d);
        if (JSON.stringify(combined ? getReviewRule(current) : getObserverRule({ ...current, mode: "cumulative" })) === JSON.stringify(rule)) return d.observerEditorRevision ?? d.observerPolicyRevision ?? 0;
        d.settings.observer = normalizeObserverSettings(combined ? { reviewRule: rule } : { analysisRule: rule, prompt: "" }, current);
        const nextRevision = (d.observerEditorRevision ?? d.observerPolicyRevision ?? 0) + 1;
        activeChanged = current.mode === (combined ? "combined" : "cumulative");
        if (activeChanged) { invalidateObserverJobs(d); d.observerPolicyRevision = (d.observerPolicyRevision || 0) + 1; }
        return d.observerEditorRevision = nextRevision;
      });
      if (activeChanged) {
        for (const flight of observerFlights.values()) flight.controller.abort();
        observerSimulations.clear();
      }
      notify(); return { rule, revision };
    }
    const rule = normalizeRule(message.rule);
    const revision = await change(d => {
      if (!Number.isInteger(message.revision) || message.revision !== (d.settings.analysisRevision || 0)) throw new Error(t("ui_settings_changed_in_another_window_copy_your_draft_then_load"));
      if (d.settings.analysisRule && JSON.stringify(getAnalysisRule(d.settings)) === JSON.stringify(rule)) return d.settings.analysisRevision || 0;
      d.settings.analysisRule = rule;
      d.settings.analysisRevision = (d.settings.analysisRevision || 0) + 1;
      for (const session of Object.values(d.sessions)) { session.results = {}; session.count = 0; }
      return d.settings.analysisRevision;
    });
    if (revision !== message.revision) abortFlights(() => true);
    notify(); return { rule, revision };
  }
  if (type === "TASK_UNDO_PREVIEW" || type === "UNDO_TASK") {
    const account = normalizeHandle(message.account), rootId = numericId(message.rootId);
    if (!rootId) throw new Error(t("ui_cannot_identify_the_task_s_original_post"));
    if (type === "TASK_UNDO_PREVIEW") return taskUndoSummary(taskUndoPlan(await read(), account, rootId));
    const result = await change(d => {
      const plan = taskUndoPlan(d, account, rootId);
      for (const s of Object.values(d.sessions)) if (taskScope(s, account, rootId)) { s.stopped = true; s.active = false; }
      for (const h of d.history) if (taskScope(h, account, rootId)) {
        h.taskWithdrawn = true; h.stanceOwner = false;
        if (h.observerOwner || h.nameOwner) { h.module = h.observerOwner ? "observer" : "name"; for (const j of d.jobs) if (j.historyId === h.id && j.kind === "block" && !j.submitted) { j.module = h.module; j.manual = false; } }
      }
      for (const historyId of plan.cancel) {
        const h = d.history.find(h => h.id === historyId);
        const job = d.jobs.find(j => j.historyId === historyId && j.kind === "block" && ["pending", "running"].includes(j.status));
        if (job) { job.status = "cancelled"; h.status = "cancelled"; h.updated = Date.now(); h.error = ""; }
      }
      for (const historyId of [...plan.ready, ...plan.inFlight]) {
        const h = d.history.find(h => h.id === historyId); h.undoRequested = true;
        if (plan.ready.includes(historyId)) enqueueUnblock(d, h);
      }
      return { ...taskUndoSummary(plan), sessionIds: Object.values(d.sessions).filter(s => taskScope(s, account, rootId)).map(s => s.id) };
    });
    abortFlights(f => result.sessionIds.includes(f.sessionId));
    notify(); void drain(); return result;
  }
  if (type === "SAVE_MODEL_CONFIG" || type === "SAVE_KEY") {
    const previous = (await read()).settings;
    const next = updateSettings(previous, type === "SAVE_KEY" ? {} : {
      endpoint: message.config?.endpoint, model: message.config?.model, customPrompt: message.config?.customPrompt,
    });
    const entered = String(message.value || "").trim();
    const previousKey = await key();
    if (!entered && new URL(next.endpoint || DEFAULT_ENDPOINT).origin !== new URL(previous.endpoint || DEFAULT_ENDPOINT).origin) throw new Error(t("ui_api_domain_changed_enter_the_new_service_s_api_key"));
    const secret = entered || previousKey;
    if (secret.length < 10 || secret.length > 500 || /\s/.test(secret)) throw new Error(t("ui_enter_a_valid_api_key"));
    // Validate the actual choice schema using synthetic text, never a user's tweet.
    const root = { id: "100000", text: "请按时赴约。", hasMedia: false, incomplete: false };
    const reply = { id: "100001", parentId: root.id, text: "同意，守时是基本礼貌。", hasMedia: false, incomplete: false };
    const answer = await askJev(buildRequest(root, reply, null, next.model, next.customPrompt, next.analysisRule), secret, undefined, next.endpoint);
    try { parseDecision(answer, next, root, reply, null); }
    catch { throw new Error(t("ui_endpoint_did_not_return_a_valid_jev_result_settings_were")); }
    const changed = await change(d => {
      if ((d.settings.analysisRevision || 0) !== (previous.analysisRevision || 0)) throw new Error(t("ui_model_settings_changed_in_another_window_save_again"));
      const changed = ["endpoint", "model", "customPrompt"].some(k => next[k] !== d.settings[k]) || secret !== previousKey;
      if (["endpoint", "model"].some(k => next[k] !== d.settings[k])) invalidateObserverJobs(d);
      if (changed) {
        d.settings.analysisRevision = (d.settings.analysisRevision || 0) + 1;
        for (const session of Object.values(d.sessions)) { session.results = {}; session.count = 0; }
      }
      // Merge only model fields: do not overwrite thresholds saved during the connection check.
      for (const k of ["endpoint", "model", "customPrompt"]) d.settings[k] = next[k];
      d.modelError = "";
      return changed;
    }, { jevKey: secret });
    if (changed) abortFlights(() => true);
    notify(); return true;
  }
  if (type === "REMOVE_KEY") {
    await change(d => { d.settings.analysisRevision = (d.settings.analysisRevision || 0) + 1; }, { jevKey: "" });
    abortFlights(() => true); notify(); return true;
  }
  if (type === "SAVE_SETTINGS") {
    await change(d => {
      if (message.value?.filterRules !== undefined && message.filterSignature !== JSON.stringify(getFilterRules(d.settings))) throw new Error(t("ui_settings_changed_in_another_window_copy_your_draft_then_load"));
      const next = updateSettings(d.settings, message.value || {});
      if (["endpoint", "model", "customPrompt"].some(k => next[k] !== d.settings[k])) throw new Error(t("ui_save_connection_details_in_model_settings"));
      if (["high", "confidence", "skipFollowing"].some(key => next[key] !== d.settings[key])) {
        for (const s of Object.values(d.sessions)) { s.results = {}; s.count = 0; }
      }
      if (JSON.stringify(next.observer) !== JSON.stringify(d.settings.observer)) {
        d.observerEditorRevision = (d.observerEditorRevision ?? d.observerPolicyRevision ?? 0) + 1;
        d.observerPolicyRevision = (d.observerPolicyRevision || 0) + 1;
      }
      if (observerPolicyKeys.some(k => JSON.stringify(next.observer?.[k]) !== JSON.stringify(d.settings.observer?.[k]))) invalidateObserverJobs(d);
      d.settings = next;
      if (message.value?.filterRules !== undefined) d.filterErrors = {};
      invalidateNameJobs(d);
      cancelFollowingJobs(d);
    });
    if (message.value?.filterRules !== undefined || message.value?.nameBlockAI !== undefined || message.value?.nameBlockBNB !== undefined || message.value?.blockHiddenText !== undefined) abortFlights(() => true);
    if (message.value?.observer) for (const flight of observerFlights.values()) flight.controller.abort();
    if (message.value?.observer?.mode === "cumulative" || message.value?.observer?.enabled === false) await clearAccountReviewData();
    await globalThis.BlockSBI18n.setLanguage?.((await read()).settings.language || "auto");
    void cleanJevCache((await read()).settings.cacheLimit).catch(() => console.warn(t("ui_block_s_b_cache_cleanup_failed")));
    if (message.value?.paused) abortFlights(() => true);
    notify(); void drain(); return true;
  }
  if (type === "TOGGLE_PAUSE") {
    await change(d => { d.settings.paused = !d.settings.paused; });
    if ((await read()).settings.paused) abortFlights(() => true);
    notify(); void drain(); return true;
  }
  if (type === "RESUME_SERVICES") {
    await change(d => { d.modelError = ""; d.queueError = ""; }); notify(); void drain(); return true;
  }
  if (type === "WHITELIST_ADD") {
    const target = { handle: normalizeHandle(message.handle), userId: numericId(message.userId), name: String(message.name || "").slice(0, 80), note: String(message.note || "").slice(0, 100), created: Date.now() };
    abortFlights(f => f.handle === target.handle || f.parentHandle === target.handle || f.contextHandles?.includes(target.handle));
    await change(d => {
      const w = d.whitelist.find(w => sameTarget(w, target));
      if (w) { w.note = target.note; if (target.userId) w.userId = target.userId; } else d.whitelist.push(target);
      for (const s of Object.values(d.sessions)) if (sameTarget(s.root, target)) { s.paused = true; cancelSession(d, s.id); }
      for (const j of d.jobs) if (j.kind === "block" && (j.status === "pending" || j.status === "running" && !j.submitted) && sameTarget(j.target, target)) {
        j.status = "cancelled"; const h = d.history.find(h => h.id === j.historyId); if (h) { h.status = "cancelled"; h.updated = Date.now(); }
      }
      if (ui && message.undoId) { const h = d.history.find(h => h.id === message.undoId && sameTarget(h.target, target)); if (h && ["blocked", "submitted"].includes(h.status)) enqueueUnblock(d, h); }
    });
    const observed = await readObserverAll();
    const users = new Map(observed.filter(e => sameTarget(e, target)).map(e => [e.userKey, e]));
    await Promise.all([...users.values()].map(e => forgetObserverUser(e.account, e.userId)));
    for (const userKey of users.keys()) observerSimulations.delete(userKey);
    notify(); void drain(); return true;
  }
  if (type === "WHITELIST_REMOVE") { if (!ui) throw new Error(t("ui_remove_users_from_the_allowlist_panel")); await change(d => { d.whitelist = d.whitelist.filter(w => w.handle !== normalizeHandle(message.handle)); }); notify(); return true; }
  if (type === "ARM") {
    if (!web) throw new Error(t("ui_start_from_the_post_menu"));
    if (!(await key())) throw new Error(t("ui_connect_jev_in_settings_first"));
    const root = sanitizePost(message.root), account = normalizeHandle(message.account);
    const binding = await bindAccount(sender.tab.id, account);
    abortFlights(f => f.tabId === sender.tab.id);
    const session = await change(d => {
      if (root.handle === account) throw new Error(t("ui_you_cannot_block_yourself_2"));
      if (isWhitelisted(d, root)) throw new Error(t("ui_the_original_author_is_allowlisted_remove_them_before_starting"));
      // Selecting a different post changes analysis scope, not previously queued block jobs.
      const s = { id: id(), tabId: sender.tab.id, account, ...binding, root, dryRun: !!d.debugDryRun, active: false, paused: false, stopped: false, sortRequired: true, pageReady: false, autoLoad: !!d.settings.autoLoadDefault, authorQueued: false, results: {}, excluded: [], count: 0, created: Date.now() };
      d.sessions[sender.tab.id] = s; return s;
    }); notify(); return session;
  }
  if (type === "LOCATION") {
    if (!web) throw new Error(t("ui_invalid_page"));
    const account = message.account ? normalizeHandle(message.account) : "";
    const actualPostId = await currentPostId(sender);
    const confirmed = await change(d => {
      const s = d.sessions[sender.tab.id]; if (!s || message.sessionId && message.sessionId !== s.id) return null;
      // Content confirms X's selected menu item and first-page readiness; URL parameters are not evidence.
      s.onThread = account === s.account && message.postId === s.root.id && actualPostId === s.root.id;
      s.pageReady = s.onThread && message.pageReady === true && message.sort === "recent";
      s.active = !s.stopped && s.onThread && (!s.sortRequired || s.pageReady);
      if (!s.stopped && s.onThread && message.root) {
        const root = sanitizePost(message.root);
        if (root.id === s.root.id && root.handle === s.root.handle) s.root = root;
      }
      if (s.active && !s.authorQueued && !s.paused && !d.settings.paused && !isWhitelisted(d, s.root)) {
        enqueueBlock(d, s, s.root, null, null, "author"); s.authorQueued = true;
        if (d.debugDryRun) s.authorSimulatedAt = Date.now();
      }
      return { sessionId: s.id, onThread: s.onThread, pageReady: s.pageReady, active: s.active };
    });
    if (confirmed && !confirmed.onThread) abortFlights(f => f.tabId === sender.tab.id && f.sessionId === confirmed.sessionId);
    notify(); void drain(); return confirmed;
  }
  if (type === "AUTO_LOAD") {
    if (!web || typeof message.enabled !== "boolean") throw new Error(t("ui_toggle_auto_load_from_the_replies"));
    const actualPostId = await currentPostId(sender);
    await change(d => {
      const s = d.sessions[sender.tab.id];
      if (!s || s.id !== message.sessionId || s.stopped || s.account !== normalizeHandle(message.account) || actualPostId !== s.root.id) throw new Error(t("ui_current_thread_task_changed"));
      s.autoLoad = message.enabled;
    });
    notify(); return true;
  }
  if (type === "STOP_SESSION") {
    const tabId = ui ? Number(message.tabId) : sender.tab.id;
    await change(d => { const s = d.sessions[tabId]; if (s) { s.active = false; s.stopped = true; cancelSession(d, s.id); } });
    abortFlights(f => f.tabId === tabId); notify(); return true;
  }
  if (type === "MANUAL_BLOCK") {
    if (!web) throw new Error(t("ui_use_the_button_next_to_a_reply"));
    const account = normalizeHandle(message.account), reply = sanitizePost(message.reply), root = sanitizePost(message.root);
    if (await currentPostId(sender) !== root.id || reply.id === root.id) throw new Error(t("ui_thread_changed_try_again"));
    const binding = await bindAccount(sender.tab.id, account);
    // A manual click can overtake the next DOM inventory batch. Preserve its text before
    // submitting to X, which may replace this post with a blocked-account placeholder.
    const before = await read();
    if (!isWhitelisted(before, reply) && reply.conversationId === root.conversationId) await syncThreadContext(account, root.id, [reply], []);
    const result = await change(d => {
      if (reply.handle === account) throw new Error(t("ui_you_cannot_block_yourself_2"));
      if (skipFollowing(d, account, reply)) throw new Error(t("ui_following_protected"));
      if (isWhitelisted(d, reply)) throw new Error(t("ui_this_user_is_allowlisted_remove_them_first"));
      if (d.queueError) throw new Error(t("ui_block_queue_needs_attention_open_the_trash_to_review"));
      const current = d.sessions[sender.tab.id];
      const s = current?.account === account && current.root.id === root.id ? { ...current, ...binding } : { id: id(), account, ...binding, tabId: sender.tab.id, root, excluded: [], results: {} };
      if (d.debugDryRun) {
        if (!current || current.stopped || current.account !== account || current.root.id !== root.id) throw new Error(t("ui_thread_changed_try_again"));
        current.dryRun = true;
        current.results[reply.id] = { ...(current.results[reply.id] || {}), action: "block", dryRun: true, simulatedAt: Date.now(), handle: reply.handle, historyId: null };
        return { id: null, status: "simulated" };
      }
      const historyId = enqueueBlock(d, s, reply, reply, s.results[reply.id] || null, "manual");
      const h = d.history.find(h => h.id === historyId);
      return { id: historyId, status: h.status };
    });
    notify(); void drain(); return result;
  }
  if (type === "CLASSIFY") { if (!web) throw new Error(t("ui_invalid_page")); return classify(message, sender); }
  if (type === "ACTION_ALLOWED" || type === "ACTION_SUBMIT") { if (!web) return false; return permit(message.jobId, sender, type === "ACTION_SUBMIT", message.baseline); }
  if (type === "UNDO") {
    const original = (await read()).history.find(h => h.id === message.id);
    if (message.module !== "name" && original?.target.userId && (message.module === "observer" || !original.observerOwner || original.module === "observer")) {
      abortFlights(f => f.account === original.account && f.userId === original.target.userId);
      await forgetObserverUser(original.account, original.target.userId);
      observerSimulations.delete(observerUserKey(original.account, original.target.userId));
    }
    await change(d => {
      const h = d.history.find(h => h.id === message.id);
      if (h && message.module !== "name") snoozeObserver(d, h.account, h.target.userId);
      if (h && message.module === "name") {
        if (message.ruleId) {
          if (!h.nameRuleIds?.includes(message.ruleId)) return;
          d.filterRuleExclusions ||= {};
          const key = `${h.account}:${h.target.userId}`;
          d.filterRuleExclusions[key] = [...new Set([...(d.filterRuleExclusions[key] || []), message.ruleId])];
          h.target.filterGrants ||= Object.fromEntries(matchingNameRules(d.settings, h.target).map(id => [id, filterStamp(getProcessingFilters(d.settings).find(r => r.id === id))]));
          delete h.target.filterGrants[message.ruleId];
          for (const job of d.jobs) if (job.historyId === h.id && job.kind === "block") job.target.filterGrants = h.target.filterGrants;
          if (matchingNameRules(d.settings, h.target).length) return;
        }
        h.nameOwner = false; h.nameRuleWithdrawn = !message.ruleId;
        // Keep the user’s withdrawal even after completed history is cleared.
        d.nameRuleExclusions ||= {};
        if (h.target.userId && !message.ruleId) d.nameRuleExclusions[`${h.account}:${h.target.userId}`] = true;
        const jobs = d.jobs.filter(j => j.historyId === h.id && j.kind === "block");
        for (const j of jobs) j.nameAuthorizationRevoked = true;
        if (h.stanceOwner || h.observerOwner) {
          h.module = h.stanceOwner ? "stance" : "observer";
          for (const j of jobs) if (!j.submitted) j.module = h.module;
          return;
        }
        const job = jobs.find(j => ["pending", "running"].includes(j.status));
        if (job) { if (job.submitted) h.undoRequested = true; else { job.status = "cancelled"; h.status = "cancelled"; } return; }
        if (["failed", "cancelled"].includes(h.status)) { for (const j of jobs) if (j.status === "failed") j.status = "cancelled"; h.status = "cancelled"; return; }
      }
      if (h?.nameOwner && message.module !== "name" && !h.observerOwner && message.module !== "observer" && !message.whitelist) {
        h.stanceOwner = false; h.module = "name";
        for (const j of d.jobs) if (j.historyId === h.id && j.kind === "block" && !j.submitted) { j.module = "name"; j.manual = false; }
        return;
      }
      if (h?.observerOwner && h.module !== "observer" && message.module !== "observer" && !message.whitelist) {
        h.stanceOwner = false; h.module = "observer";
        for (const j of d.jobs) if (j.historyId === h.id && j.kind === "block" && !j.submitted) { j.module = "observer"; j.manual = false; }
        return;
      }
      if (h && message.module === "observer") {
        h.observerOwner = false;
        if (h.nameOwner && !h.stanceOwner) { h.module = "name"; for (const j of d.jobs) if (j.historyId === h.id && j.kind === "block" && !j.submitted) j.module = "name"; return; }
        if (h.stanceOwner || h.module !== "observer") return;
        const job = d.jobs.find(j => j.historyId === h.id && j.kind === "block" && ["pending", "running"].includes(j.status));
        if (job) { if (job.submitted) h.undoRequested = true; else { job.status = "cancelled"; h.status = "cancelled"; } return; }
      }
      if (!h || !["blocked", "submitted", "undo_failed"].includes(h.status)) throw new Error(t("ui_this_record_cannot_be_unblocked_right_now"));
      h.observerOwner = false;
      if (message.whitelist && !isWhitelisted(d, h.target)) d.whitelist.push({ ...h.target, note: t("ui_added_when_unblocking"), created: Date.now() });
      enqueueUnblock(d, h);
    }); notify(); void drain(); return true;
  }
  if (type === "CANCEL_JOB") {
    if (!ui) throw new Error(t("ui_use_the_history_panel"));
    const before = await read(), original = before.history.find(h => h.id === message.id);
    if (original?.module === "observer" && before.jobs.some(j => j.historyId === original.id && j.status === "pending")) {
      abortFlights(f => f.account === original.account && f.userId === original.target.userId);
      await forgetObserverUser(original.account, original.target.userId);
      observerSimulations.delete(observerUserKey(original.account, original.target.userId));
    }
    await change(d => {
      const j = d.jobs.find(j => j.historyId === message.id && j.status === "pending"); if (!j) throw new Error(t("ui_action_already_started_submitted_requests_cannot_be_canceled"));
      const h = d.history.find(h => h.id === message.id);
      if (j.kind === "block" && (h.observerOwner || h.nameOwner) && h.module === "stance") { h.stanceOwner = false; h.module = h.observerOwner ? "observer" : "name"; j.module = h.module; j.manual = false; return; }
      j.status = "cancelled"; h.status = j.kind === "unblock" ? h.verification === "http-only" ? "submitted" : "blocked" : "cancelled"; h.updated = Date.now();
      if (j.kind === "block") h.observerOwner = false;
      for (const s of Object.values(d.sessions)) if (s.account === h.account && !s.excluded.includes(h.target.handle)) s.excluded.push(h.target.handle);
    }); notify(); return true;
  }
  if (type === "RETRY_JOB") {
    await change(d => {
      const j = d.jobs.find(j => j.historyId === message.id && j.status === "failed"); if (!j) throw new Error(t("ui_verify_unknown_results_before_retrying"));
      if (j.kind === "block" && j.transport === "worker" && j.submitted && !j.resultKnown) throw new Error(t("ui_verify_unknown_results_before_retrying"));
      const record = d.history.find(h => h.id === j.historyId);
      if (j.kind === "block" && j.observerAuthorizationRevoked && !record?.stanceOwner && !record?.nameOwner && !j.manual) throw new Error(t("ui_task_canceled"));
      if (j.kind === "block" && j.nameAuthorizationRevoked && !record?.stanceOwner && !record?.observerOwner) throw new Error(t("ui_task_canceled"));
      if (j.kind === "block" && record?.taskWithdrawn && !record?.observerOwner && !record?.nameOwner) throw new Error(t("ui_this_task_was_undone_start_again_from_the_original_post"));
      if (protectedFollowingJob(d, j)) throw new Error(t("ui_following_protected"));
      if (j.kind === "block" && isWhitelisted(d, j.target)) throw new Error(t("ui_this_user_is_already_allowlisted"));
      j.status = "pending"; j.submitted = false; j.resultKnown = false;
      const h = d.history.find(h => h.id === j.historyId); h.status = j.kind === "block" ? "pending" : "undo_pending"; h.error = "";
      d.queueError = "";
    }); notify(); void drain(); return true;
  }
  if (type === "RECONCILE") {
    const db = await read(), h = db.history.find(h => h.id === message.id);
    if (!h || h.status !== "uncertain") throw new Error(t("ui_no_records_need_verification"));
    const j = db.jobs.find(j => j.historyId === h.id && j.status === "uncertain");
    const tabId = await findActionTab({ ...j, kind: "unblock" });
    if (tabId === null) throw new Error(t("ui_open_x_signed_in_as_first", h.account));
    const r = await chrome.tabs.sendMessage(tabId, { type: "INSPECT_TARGET", account: h.account, target: h.target });
    if (!r?.ok) throw new Error(r?.error || t("ui_cannot_verify_account_status"));
    await change(d => {
      const entry = d.history.find(x => x.id === h.id), job = d.jobs.find(x => x.id === j.id);
      // Explicit user reconciliation accepts the observed state; no automatic mutation occurs here.
      if (r.target.blocking) { entry.status = j.kind === "unblock" ? "undo_failed" : "blocked"; entry.owned = entry.owned || j.wasBlocked === false; if (j.kind === "block") markTrashUnread(entry); }
      else entry.status = j.kind === "unblock" ? "unblocked" : "failed";
      job.status = ["failed", "undo_failed"].includes(entry.status) ? "failed" : "done";
      job.resultKnown = true;
      if (job.kind === "block" && job.status === "failed") { finishObserverRevocation(job, entry); finishNameRevocation(job, entry); }
      entry.error = ""; entry.updated = Date.now(); d.queueError = "";
    }); notify(); return true;
  }
  if (type === "EXPORT") { const d = await read(); return { version: 1, exported: new Date().toISOString(), whitelist: d.whitelist, history: d.history }; }
  if (type === "CLEAR_FINISHED") { await change(d => { const removed = new Set(d.history.filter(h => ["unblocked", "cancelled"].includes(h.status)).map(h => h.id)); d.history = d.history.filter(h => !removed.has(h.id)); d.jobs = d.jobs.filter(j => !removed.has(j.historyId)); }); notify(); return true; }
  throw new Error(t("ui_unknown_action"));
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === "filter-offscreen") return;
  if (["STATE_CHANGED", "EXECUTE_ACTION", "GET_VIEWER", "INSPECT_TARGET"].includes(message?.type)) return;
  handle(message, sender).then(data => respond({ ok: true, data }), e => respond({ ok: false, error: e.message || t("ui_action_failed") }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "blocksb-subscriptions") void subscriptions.due().catch(() => {});
  if (alarm.name === "blocksb-queue") void drain();
  if (alarm.name === "blocksb-cache-cleanup") void (async () => {
    // A failed IndexedDB cleanup must not prevent session-result expiry in local storage.
    await cleanJevCache((await read()).settings.cacheLimit).catch(() => console.warn(t("ui_block_s_b_cache_cleanup_failed")));
    await cleanObserverEvidence(observerConfig(await read()).retentionDays).catch(() => console.warn(t("ui_block_s_b_cache_cleanup_failed")));
    await change(d => {
      for (const s of Object.values(d.sessions)) {
        s.results = Object.fromEntries(Object.entries(s.results).filter(([, result]) => (result.analyzedAt || s.created) > Date.now() - JEV_CACHE_TTL));
        s.count = Object.keys(s.results).length;
      }
    });
    notify();
  })().catch(() => console.warn(t("ui_block_s_b_cache_cleanup_failed")));
});
chrome.tabs.onRemoved.addListener(tabId => { quickUndoBatches.delete(tabId); abortFlights(f => f.tabId === tabId); void change(d => { delete d.sessions[tabId]; }); });
// A login/account change can release waiting jobs without requiring the original post or any X tab.
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (["ct0", "twid"].includes(cookie.name) && /(^|\.)(x\.com|twitter\.com)$/.test(cookie.domain)) {
    if (cookie.name === "twid") for (const flight of observerFlights.values()) flight.controller.abort();
    void drain();
  }
});
// Chrome rejects top-level await anywhere in a service worker's module graph.
// Register listeners synchronously above, then initialize storage and queue asynchronously.
void ready.then(async () => {
  // Apply built-in observation protection to unsent jobs restored from older versions.
  if (await read(d => d.jobs.some(j => ["pending", "running", "failed", "uncertain"].includes(j.status)))) {
    await change(d => { invalidateNameJobs(d); cancelFollowingJobs(d); });
  }
  await globalThis.BlockSBI18n.setLanguage?.((await read()).settings.language || "auto");
  const [queueAlarm, cleanupAlarm] = await Promise.all([chrome.alarms.get("blocksb-queue"), chrome.alarms.get("blocksb-cache-cleanup")]);
  if (!queueAlarm) await chrome.alarms.create("blocksb-queue", { periodInMinutes: 0.5 });
  if (!cleanupAlarm) {
    await chrome.alarms.create("blocksb-cache-cleanup", { periodInMinutes: 60 });
    void read(d => d.settings.cacheLimit).then(cleanJevCache).catch(() => console.warn(t("ui_block_s_b_cache_cleanup_failed")));
  }
  if (!await chrome.alarms.get("blocksb-subscriptions")) await chrome.alarms.create("blocksb-subscriptions", { periodInMinutes: 60 });
  void subscriptions.due().catch(() => {});
  await drain();
}).catch(error => {
  console.error("block s.b. startup:", error.message);
});
