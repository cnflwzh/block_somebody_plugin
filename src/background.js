import { read, change, key, ready } from "./lib/store.js";
import { PRESETS, DEFAULT_ENDPOINT, JEV_CACHE_TTL, STANCE_PROMPT_VERSION, DECISION_VERSION, decideAction, normalizeHandle, sanitizePost, numericId, isWhitelisted, sameTarget, updateSettings, buildRequest, parseDecision, validateThread } from "./lib/core.js";
import { askJev } from "./lib/jev.js";
import { askJevCached, cleanJevCache, requestKey } from "./lib/jev-cache.js";
import { xSession, postBlock } from "./lib/x-block.js";

const X_URLS = ["https://x.com/*", "https://twitter.com/*"];
const flights = new Map();
let draining = false;
let drainTimer;
let notifyTimer;
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
async function snapshot(sender, accountValue) {
  const db = await read();
  const settings = { ...db.settings, configured: !!(await key()) };
  if (sender.url?.startsWith(extensionOrigin)) return { settings, presets: PRESETS, whitelist: db.whitelist, history: db.history.slice().reverse(), sessions: Object.values(db.sessions), queueError: db.queueError, queueNotice: db.queueNotice || "", modelError: db.modelError };
  const s = db.sessions[sender.tab.id];
  const account = accountValue ? normalizeHandle(accountValue) : "";
  const { endpoint, customPrompt, ...pageSettings } = settings;
  return { settings: pageSettings, account, decisionVersion: DECISION_VERSION, whitelist: db.whitelist.map(w => ({ handle: w.handle, userId: w.userId })), session: s?.account === account ? s : null, queueError: db.queueError, queueNotice: db.queueNotice || "", modelError: db.modelError,
    history: db.history.filter(h => h.account === account).map(h => ({ id: h.id, target: h.target, status: h.status, sessionId: h.sessionId, rootId: h.root?.id, replyId: h.reply?.id, updated: h.updated })) };
}
function sessionFor(db, tabId, sessionId, account) {
  const s = db.sessions[tabId];
  if (!s || s.id !== sessionId || s.account !== account || !s.active || s.paused || s.stopped || db.settings.paused) throw new Error("当前评论区任务已暂停或切换。");
  return s;
}
function cancelSession(db, sessionId) {
  for (const j of db.jobs) if (j.sessionId === sessionId && !j.manual && j.kind === "block" && (j.status === "pending" || j.status === "running" && !j.submitted)) {
    j.status = "cancelled";
    const h = db.history.find(h => h.id === j.historyId);
    if (h) { h.status = "cancelled"; h.updated = Date.now(); }
  }
}
function abortFlights(predicate) { for (const f of flights.values()) if (predicate(f)) f.controller.abort(); }

/** Enqueue an explicit user choice or validated model decision; deduplicate by account identity. */
function enqueueBlock(db, s, target, reply, decision, reason) {
  const manual = reason === "manual";
  if (isWhitelisted(db, target) || target.handle === s.account || (!manual && s.excluded.includes(target.handle))) return null;
  const existing = db.history.findLast(h => h.account === s.account && sameTarget(h.target, target));
  if (existing && !["unblocked", "cancelled"].includes(existing.status)) return existing.id;
  if (db.history.length >= 5000) throw new Error("操作记录已达到 5000 条，请导出并清理已完成的记录。");
  const h = { id: id(), account: s.account, target: { handle: target.handle, userId: target.userId || "", name: target.name }, root: { ...s.root, text: s.root.text.slice(0, 1500) },
    reply: reply ? { ...reply, text: reply.text.slice(0, 1500) } : null, decision, reason, sessionId: s.id, status: "pending", created: Date.now(), updated: Date.now(), error: "", owned: false };
  db.history.push(h);
  db.jobs.push({ id: id(), historyId: h.id, kind: "block", account: s.account, actorId: s.actorId || "", origin: s.origin || "https://x.com", target: h.target, tabId: s.tabId, sessionId: s.id, manual, rootId: s.root.id, status: "pending", created: Date.now(), submitted: false });
  return h.id;
}
function enqueueUnblock(db, h) {
  if (!h.owned) throw new Error("这条记录没有由本插件提交的屏蔽请求，不能在此撤销。");
  if (db.jobs.some(j => j.historyId === h.id && ["pending", "running"].includes(j.status))) throw new Error("该账号已有待处理操作。");
  for (const s of Object.values(db.sessions)) if (s.account === h.account && !s.excluded.includes(h.target.handle)) s.excluded.push(h.target.handle);
  h.status = "undo_pending"; h.error = ""; h.updated = Date.now();
  db.jobs.push({ id: id(), historyId: h.id, kind: "unblock", account: h.account, target: h.target, status: "pending", created: Date.now(), submitted: false });
}

/** A task is one selected tweet under one acting account, even across repeated sessions. */
function taskScope(entry, account, rootId) { return entry.account === account && entry.root?.id === rootId; }

/** Compute a fresh undo preview from durable records; never trust IDs/counts supplied by the UI. */
function taskUndoPlan(db, account, rootId) {
  const rows = db.history.filter(h => taskScope(h, account, rootId));
  const sessions = Object.values(db.sessions).filter(s => taskScope(s, account, rootId));
  if (!rows.length && !sessions.length) throw new Error("任务不存在或已经清理。");
  const plan = { account, rootId, root: rows[0]?.root || sessions[0].root, ready: [], cancel: [], inFlight: [], existing: 0, review: 0, protected: 0, active: sessions.filter(s => !s.stopped).length };
  for (const h of rows) {
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

async function classify(message, sender) {
  const tabId = sender.tab.id;
  const reply = sanitizePost(message.reply);
  const account = normalizeHandle(message.account);
  const flightKey = `${tabId}:${message.sessionId}:${reply.id}`;
  if (flights.has(flightKey)) return flights.get(flightKey).promise;
  const controller = new AbortController();
  const promise = (async () => {
    let db = await read();
    let s = sessionFor(db, tabId, message.sessionId, account);
    if (await currentPostId(sender) !== s.root.id || reply.id === s.root.id || reply.conversationId !== s.root.conversationId) throw new Error("评论不属于当前选中的会话。");
    if (s.sortRequired && !s.pageReady) return { action: "skip", why: "waiting-first-page" };
    if (reply.handle === account || reply.handle === s.root.handle || isWhitelisted(db, reply) || s.excluded.includes(reply.handle)) return { action: "skip" };
    if (db.modelError) throw new Error(db.modelError);
    if (!s.results[reply.id] && Object.keys(s.results).length >= 2000) throw new Error("本次任务已分析 2000 条，请结束后重新启用。");
    const ancestry = Array.isArray(message.ancestors) && message.ancestors.length <= 30 ? message.ancestors.map(sanitizePost) : [];
    if (!validateThread(s.root, reply, ancestry)) return { action: "skip", why: "missing-parent" };
    const parent = ancestry[0] || null;
    // Nested replies need their actual parent, not whichever card happens to be above them.
    if (!reply.parentId || (reply.parentId !== s.root.id && !parent)) return { action: "skip", why: "missing-parent" };
    if (!reply.text.trim()) return { action: "skip", why: "no-text" };
    const analysisConfig = db.settings;
    const revision = analysisConfig.analysisRevision || 0;
    const request = buildRequest(s.root, reply, parent, analysisConfig.model, analysisConfig.customPrompt);
    const digest = await requestKey(request, analysisConfig.endpoint);
    const cached = s.results[reply.id];
    if (cached?.requestKey === digest && cached.analyzedAt > Date.now() - JEV_CACHE_TTL) {
      if (cached.error) return cached;
      // A stored score is reusable; an old keep/block action is not an immutable decision.
      // Rechecking policy must neither charge Jev nor bypass current whitelist/undo guards.
      return change(d => {
        const current = sessionFor(d, tabId, message.sessionId, account);
        if (isWhitelisted(d, current.root) || isWhitelisted(d, reply) || ancestry.some(p => isWhitelisted(d, p)) || current.excluded.includes(reply.handle) || controller.signal.aborted) return { action: "skip" };
        if ((d.settings.analysisRevision || 0) !== revision) return { action: "skip", why: "config-changed" };
        const result = decideAction(cached, d.settings, current.root, reply, parent);
        if (result.action === "block") result.historyId = enqueueBlock(d, current, reply, reply, result, "supporter");
        current.results[reply.id] = result;
        return result;
      });
    }
    const flight = flights.get(flightKey);
    if (flight) flight.contextHandles = [s.root.handle, ...ancestry.map(p => p.handle)];
    const apiKey = await key();
    // Recheck after every await immediately before external transmission.
    db = await read(); s = sessionFor(db, tabId, message.sessionId, account);
    if (isWhitelisted(db, s.root) || isWhitelisted(db, reply) || ancestry.some(p => isWhitelisted(db, p)) || s.excluded.includes(reply.handle) || controller.signal.aborted) return { action: "skip" };
    if ((db.settings.analysisRevision || 0) !== revision) return { action: "skip", why: "config-changed" };
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
          if (controller.signal.aborted || (d.settings.analysisRevision || 0) !== revision || isWhitelisted(d, reply) || current.excluded.includes(reply.handle)) return { action: "skip", why: "config-changed" };
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
      if (isWhitelisted(d, current.root) || isWhitelisted(d, reply) || ancestry.some(p => isWhitelisted(d, p)) || current.excluded.includes(reply.handle) || controller.signal.aborted) return { action: "skip" };
      // A cached model answer must still pass today's thresholds and account protections.
      if ((d.settings.analysisRevision || 0) !== revision) return { action: "skip", why: "config-changed" };
      result = parseDecision(payload, d.settings, current.root, reply, parent);
      if (result.action === "block") result.historyId = enqueueBlock(d, current, reply, reply, result, "supporter");
      if (!current.results[reply.id]) current.count++;
      current.results[reply.id] = { ...result, handle: reply.handle, analyzedAt: payload.cacheCreatedAt, requestKey: digest };
      return current.results[reply.id];
    });
  })();
  flights.set(flightKey, { promise, controller, tabId, sessionId: message.sessionId, handle: reply.handle, parentHandle: message.parent?.handle });
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
  if (!isX(tab.url) || tab.incognito) throw new Error("请在普通窗口中已登录的 X 页面启动任务。");
  const origin = new URL(tab.url).origin;
  const before = await xSession(origin);
  const visible = await chrome.tabs.sendMessage(tabId, { type: "GET_VIEWER" });
  const after = await xSession(origin);
  if (visible?.account !== account || before.actorId !== after.actorId) throw new Error("登录账号已切换，请重新启动任务。");
  return { actorId: after.actorId, origin };
}

/** Only unblocking/reconciliation still use a page adapter; block jobs are worker-owned. */
async function permit(jobId, sender, mark, baseline) {
  return await change(d => {
    const j = d.jobs.find(j => j.id === jobId);
    if (!j || j.status !== "running" || j.actionTab !== sender.tab.id || (mark && j.submitted)) return false;
    if (j.kind !== "unblock") return false;
    if (mark) {
      if (!baseline || !numericId(baseline.userId) || typeof baseline.blocking !== "boolean" || normalizeHandle(baseline.handle) !== j.target.handle) throw new Error("账号核验失败。");
      if (j.target.userId && j.target.userId !== baseline.userId) throw new Error("用户名对应的账号已变化，已停止操作。");
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
      || db.jobs.find(j => j.status === "pending" && j.kind === "block" && !db.queueError && !db.settings.paused);
    if (!job) return;
    if (job.kind === "block" && isWhitelisted(db, job.target)) {
      await change(d => { const j = d.jobs.find(x => x.id === job.id); j.status = "cancelled"; const h = d.history.find(x => x.id === j.historyId); if (h) h.status = "cancelled"; });
      notify(); return;
    }
    let tabId = null, login;
    if (job.kind === "block") {
      try {
        // Upgrade old pending jobs once. New jobs already contain this binding and need no tab.
        if (!job.actorId) {
          const legacyTab = await findActionTab(job);
          if (legacyTab === null) throw new Error(`旧任务需要打开一次已登录 @${job.account} 的 X 页面以绑定后台队列。`);
          Object.assign(job, await bindAccount(legacyTab, job.account));
          await change(d => { const j = d.jobs.find(j => j.id === job.id); if (j) { j.actorId = job.actorId; j.origin = job.origin; } });
        }
        login = await xSession(job.origin);
        if (login.actorId !== job.actorId) throw new Error(`队列等待登录 @${job.account}；不会使用另一个账号提交。`);
      } catch (e) { await change(d => { d.queueNotice = e.message; }); notify(); return; }
    } else {
      tabId = await findActionTab(job);
      if (tabId === null) { await change(d => { d.queueNotice = `取消屏蔽需要打开已登录 @${job.account} 的任意 X 页面。`; }); notify(); return; }
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
        if (isWhitelisted(d, j.target)) {
          j.status = "cancelled"; const h = d.history.find(h => h.id === j.historyId); if (h) h.status = "cancelled";
          return false;
        }
        if (d.settings.paused || d.queueError) {
          j.status = "pending"; const h = d.history.find(h => h.id === j.historyId); if (h) h.status = "pending";
          return false;
        }
        j.submitted = true; j.transport = "worker";
        return true;
      });
      if (!allowed) { notify(); return; }
      result = await postBlock(job.target, login);
    } else {
      try { result = await chrome.tabs.sendMessage(tabId, { type: "EXECUTE_ACTION", job: { ...job, actionTab: tabId } }); }
      catch { result = { ok: false, uncertain: true, error: "页面关闭或连接中断，操作结果需要核对。" }; }
    }
    await change(d => {
      const j = d.jobs.find(x => x.id === job.id);
      const h = d.history.find(x => x.id === job.historyId);
      if (!j || !h) return;
      h.updated = Date.now();
      d.nextActionAt = Date.now() + Math.max(2500, Number(result?.retryAfterMs) || 0);
      if (result?.ok) {
        j.status = "done"; h.error = "";
        if (result.target?.userId) h.target.userId = result.target.userId;
        if (job.kind === "unblock") h.status = "unblocked";
        else if (result.preexisting) { h.status = "preexisting"; h.owned = false; }
        else { h.status = result.accepted ? "submitted" : "blocked"; h.owned = true; h.verification = result.accepted ? "http-only" : "relationship"; }
      } else if (result?.cancelled) { j.status = "cancelled"; h.status = job.kind === "unblock" ? "blocked" : "cancelled"; }
      else {
        const uncertain = result?.uncertain && j.submitted;
        j.status = uncertain ? "uncertain" : "failed";
        h.status = uncertain ? "uncertain" : job.kind === "unblock" ? "undo_failed" : "failed";
        h.error = String(result?.error || "没有收到可验证的结果。").slice(0, 300); j.error = h.error;
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
      if (db.jobs.some(j => j.status === "pending" && (j.kind === "unblock" || !db.settings.paused && !db.queueError))) {
        drainTimer = setTimeout(() => void drain(), db.queueNotice ? 30000 : Math.min(30000, Math.max(2500, db.nextActionAt - Date.now())));
        // Node's mocked worker should exit naturally; Chrome returns a numeric timer handle.
        drainTimer.unref?.();
      }
    } catch { console.warn("block s.b.: 无法读取队列，将由下一次唤醒重试。"); }
    finally { draining = false; }
  }
}

async function handle(message, sender) {
  const ui = sender.url?.startsWith(extensionOrigin);
  const web = !!sender.tab && isX(sender.url);
  if (sender.id !== chrome.runtime.id || (!ui && !web)) throw new Error("无效请求来源。");
  const type = message?.type;
  if (type === "SNAPSHOT") return snapshot(sender, message.account);
  if (type === "OPEN_MANAGER") { await chrome.tabs.create({ url: chrome.runtime.getURL("src/manager/manager.html") }); return true; }
  if (["SAVE_SETTINGS", "SAVE_MODEL_CONFIG", "SAVE_KEY", "REMOVE_KEY", "UNDO", "TASK_UNDO_PREVIEW", "UNDO_TASK", "RETRY_JOB", "RECONCILE", "CLEAR_FINISHED", "EXPORT"].includes(type) && !ui) throw new Error("请从管理面板进行此操作。");
  if (type === "TASK_UNDO_PREVIEW" || type === "UNDO_TASK") {
    const account = normalizeHandle(message.account), rootId = numericId(message.rootId);
    if (!rootId) throw new Error("无法识别任务原帖。");
    if (type === "TASK_UNDO_PREVIEW") return taskUndoSummary(taskUndoPlan(await read(), account, rootId));
    const result = await change(d => {
      const plan = taskUndoPlan(d, account, rootId);
      for (const s of Object.values(d.sessions)) if (taskScope(s, account, rootId)) { s.stopped = true; s.active = false; }
      for (const h of d.history) if (taskScope(h, account, rootId)) h.taskWithdrawn = true;
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
    if (!entered && new URL(next.endpoint || DEFAULT_ENDPOINT).origin !== new URL(previous.endpoint || DEFAULT_ENDPOINT).origin) throw new Error("更换 API 域名后，请重新输入该服务的 API Key。");
    const secret = entered || previousKey;
    if (secret.length < 10 || secret.length > 500 || /\s/.test(secret)) throw new Error("请输入有效的 API Key。");
    // Validate the actual choice schema using synthetic text, never a user's tweet.
    const root = { id: "100000", text: "请按时赴约。", hasMedia: false, incomplete: false };
    const reply = { id: "100001", parentId: root.id, text: "同意，守时是基本礼貌。", hasMedia: false, incomplete: false };
    const answer = await askJev(buildRequest(root, reply, null, next.model, next.customPrompt), secret, undefined, next.endpoint);
    try { parseDecision(answer, next, root, reply, null); }
    catch { throw new Error("接口未返回有效的 Jev 分类结果，配置未保存。"); }
    const changed = await change(d => {
      if ((d.settings.analysisRevision || 0) !== (previous.analysisRevision || 0)) throw new Error("模型设置已在其他窗口更改，请重新保存。");
      const changed = ["endpoint", "model", "customPrompt"].some(k => next[k] !== d.settings[k]) || secret !== previousKey;
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
      const next = updateSettings(d.settings, message.value || {});
      if (["endpoint", "model", "customPrompt"].some(k => next[k] !== d.settings[k])) throw new Error("请在模型设置中保存连接配置。");
      if (["high", "confidence"].some(key => next[key] !== d.settings[key])) {
        for (const s of Object.values(d.sessions)) { s.results = {}; s.count = 0; }
      }
      d.settings = next;
    });
    void cleanJevCache((await read()).settings.cacheLimit).catch(() => console.warn("block s.b.: 缓存清理失败。"));
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
    notify(); void drain(); return true;
  }
  if (type === "WHITELIST_REMOVE") { if (!ui) throw new Error("请从白名单面板移除。"); await change(d => { d.whitelist = d.whitelist.filter(w => w.handle !== normalizeHandle(message.handle)); }); notify(); return true; }
  if (type === "ARM") {
    if (!web) throw new Error("请从帖子菜单启动。");
    if (!(await key())) throw new Error("请先在设置中连接 Jev。");
    const root = sanitizePost(message.root), account = normalizeHandle(message.account);
    const binding = await bindAccount(sender.tab.id, account);
    abortFlights(f => f.tabId === sender.tab.id);
    const session = await change(d => {
      if (root.handle === account) throw new Error("不能屏蔽自己。");
      if (isWhitelisted(d, root)) throw new Error("原作者在白名单中，请先移除白名单再启用。");
      // Selecting a different post changes analysis scope, not previously queued block jobs.
      const s = { id: id(), tabId: sender.tab.id, account, ...binding, root, active: false, paused: false, stopped: false, sortRequired: true, pageReady: false, autoLoad: false, authorQueued: false, results: {}, excluded: [], count: 0, created: Date.now() };
      d.sessions[sender.tab.id] = s; return s;
    }); notify(); return session;
  }
  if (type === "LOCATION") {
    if (!web) throw new Error("无效页面。");
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
      }
      return { sessionId: s.id, onThread: s.onThread, pageReady: s.pageReady, active: s.active };
    });
    if (confirmed && !confirmed.onThread) abortFlights(f => f.tabId === sender.tab.id && f.sessionId === confirmed.sessionId);
    notify(); void drain(); return confirmed;
  }
  if (type === "AUTO_LOAD") {
    if (!web || typeof message.enabled !== "boolean") throw new Error("请从评论区切换自动加载。");
    const actualPostId = await currentPostId(sender);
    await change(d => {
      const s = d.sessions[sender.tab.id];
      if (!s || s.id !== message.sessionId || s.stopped || s.account !== normalizeHandle(message.account) || actualPostId !== s.root.id) throw new Error("当前评论区任务已切换。");
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
    if (!web) throw new Error("请从评论旁的按钮操作。");
    const account = normalizeHandle(message.account), reply = sanitizePost(message.reply), root = sanitizePost(message.root);
    if (await currentPostId(sender) !== root.id || reply.id === root.id) throw new Error("评论区已切换，请重新操作。");
    const binding = await bindAccount(sender.tab.id, account);
    const result = await change(d => {
      if (reply.handle === account) throw new Error("不能屏蔽自己。");
      if (isWhitelisted(d, reply)) throw new Error("该用户在白名单中，请先移除白名单。");
      if (d.queueError) throw new Error("屏蔽队列需要处理，请打开垃圾桶查看或核对状态。");
      const current = d.sessions[sender.tab.id];
      const s = current?.account === account && current.root.id === root.id ? { ...current, ...binding } : { id: id(), account, ...binding, tabId: sender.tab.id, root, excluded: [], results: {} };
      const historyId = enqueueBlock(d, s, reply, reply, s.results[reply.id] || null, "manual");
      const h = d.history.find(h => h.id === historyId);
      return { id: historyId, status: h.status };
    });
    notify(); void drain(); return result;
  }
  if (type === "CLASSIFY") { if (!web) throw new Error("无效页面。"); return classify(message, sender); }
  if (type === "ACTION_ALLOWED" || type === "ACTION_SUBMIT") { if (!web) return false; return permit(message.jobId, sender, type === "ACTION_SUBMIT", message.baseline); }
  if (type === "UNDO") {
    await change(d => {
      const h = d.history.find(h => h.id === message.id); if (!h || !["blocked", "submitted", "undo_failed"].includes(h.status)) throw new Error("该记录暂时不能取消屏蔽。");
      if (message.whitelist && !isWhitelisted(d, h.target)) d.whitelist.push({ ...h.target, note: "取消屏蔽时加入", created: Date.now() });
      enqueueUnblock(d, h);
    }); notify(); void drain(); return true;
  }
  if (type === "CANCEL_JOB") {
    if (!ui) throw new Error("请从历史面板操作。");
    await change(d => {
      const j = d.jobs.find(j => j.historyId === message.id && j.status === "pending"); if (!j) throw new Error("操作已开始，不能撤回已提交的请求。");
      j.status = "cancelled"; const h = d.history.find(h => h.id === message.id); h.status = j.kind === "unblock" ? h.verification === "http-only" ? "submitted" : "blocked" : "cancelled"; h.updated = Date.now();
      for (const s of Object.values(d.sessions)) if (s.account === h.account && !s.excluded.includes(h.target.handle)) s.excluded.push(h.target.handle);
    }); notify(); return true;
  }
  if (type === "RETRY_JOB") {
    await change(d => {
      const j = d.jobs.find(j => j.historyId === message.id && j.status === "failed"); if (!j) throw new Error("结果未知的操作必须先核对状态。");
      const record = d.history.find(h => h.id === j.historyId);
      if (j.kind === "block" && record?.taskWithdrawn) throw new Error("此任务已经撤回。若要重新屏蔽，请从原帖重新启动任务。");
      if (j.kind === "block" && isWhitelisted(d, j.target)) throw new Error("该用户已在白名单中。");
      j.status = "pending"; j.submitted = false;
      const h = d.history.find(h => h.id === j.historyId); h.status = j.kind === "block" ? "pending" : "undo_pending"; h.error = "";
      d.queueError = "";
    }); notify(); void drain(); return true;
  }
  if (type === "RECONCILE") {
    const db = await read(), h = db.history.find(h => h.id === message.id);
    if (!h || h.status !== "uncertain") throw new Error("没有待核对的记录。");
    const j = db.jobs.find(j => j.historyId === h.id && j.status === "uncertain");
    const tabId = await findActionTab({ ...j, kind: "unblock" });
    if (tabId === null) throw new Error(`请先打开已登录 @${h.account} 的 X 页面。`);
    const r = await chrome.tabs.sendMessage(tabId, { type: "INSPECT_TARGET", account: h.account, target: h.target });
    if (!r?.ok) throw new Error(r?.error || "无法核对账号状态。");
    await change(d => {
      const entry = d.history.find(x => x.id === h.id), job = d.jobs.find(x => x.id === j.id);
      // Explicit user reconciliation accepts the observed state; no automatic mutation occurs here.
      if (r.target.blocking) { entry.status = j.kind === "unblock" ? "undo_failed" : "blocked"; entry.owned = entry.owned || j.wasBlocked === false; }
      else entry.status = j.kind === "unblock" ? "unblocked" : "failed";
      job.status = ["failed", "undo_failed"].includes(entry.status) ? "failed" : "done";
      entry.error = ""; entry.updated = Date.now(); d.queueError = "";
    }); notify(); return true;
  }
  if (type === "EXPORT") { const d = await read(); return { version: 1, exported: new Date().toISOString(), whitelist: d.whitelist, history: d.history }; }
  if (type === "CLEAR_FINISHED") { await change(d => { const removed = new Set(d.history.filter(h => ["unblocked", "cancelled"].includes(h.status)).map(h => h.id)); d.history = d.history.filter(h => !removed.has(h.id)); d.jobs = d.jobs.filter(j => !removed.has(j.historyId)); }); notify(); return true; }
  throw new Error("未知操作。");
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (["STATE_CHANGED", "EXECUTE_ACTION", "GET_VIEWER", "INSPECT_TARGET"].includes(message?.type)) return;
  handle(message, sender).then(data => respond({ ok: true, data }), e => respond({ ok: false, error: e.message || "操作失败。" }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "blocksb-queue") void drain();
  if (alarm.name === "blocksb-cache-cleanup") void (async () => {
    // A failed IndexedDB cleanup must not prevent session-result expiry in local storage.
    await cleanJevCache((await read()).settings.cacheLimit).catch(() => console.warn("block s.b.: 缓存清理失败。"));
    await change(d => {
      for (const s of Object.values(d.sessions)) {
        s.results = Object.fromEntries(Object.entries(s.results).filter(([, result]) => (result.analyzedAt || s.created) > Date.now() - JEV_CACHE_TTL));
        s.count = Object.keys(s.results).length;
      }
    });
    notify();
  })().catch(() => console.warn("block s.b.: 缓存清理失败。"));
});
chrome.tabs.onRemoved.addListener(tabId => { abortFlights(f => f.tabId === tabId); void change(d => { delete d.sessions[tabId]; }); });
// A login/account change can release waiting jobs without requiring the original post or any X tab.
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (["ct0", "twid"].includes(cookie.name) && /(^|\.)(x\.com|twitter\.com)$/.test(cookie.domain)) void drain();
});
// Chrome rejects top-level await anywhere in a service worker's module graph.
// Register listeners synchronously above, then initialize storage and queue asynchronously.
void ready.then(async () => {
  await chrome.alarms.create("blocksb-queue", { periodInMinutes: 0.5 });
  await chrome.alarms.create("blocksb-cache-cleanup", { periodInMinutes: 60 });
  void read().then(d => cleanJevCache(d.settings.cacheLimit)).catch(() => console.warn("block s.b.: 缓存清理失败。"));
  await drain();
}).catch(error => {
  console.error("block s.b. startup:", error.message);
});
