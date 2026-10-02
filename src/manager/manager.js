import { DEFAULT_ENDPOINT, DEFAULT_STANCE_PROMPT, normalizeEndpoint, endpointPermission, updateSettings } from "../lib/core.js";

/* Extension-owned manager: never expose the key in snapshots, exports, or page messages. */
(() => {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  if (params.has("embedded")) document.body.classList.add("embedded");
  // Reuse the manager in Chrome's toolbar popup without changing the in-page drawer or options page.
  if (params.has("popup")) { document.documentElement.classList.add("popup"); document.body.classList.add("popup"); }
  let state, currentTab = ["history", "whitelist", "settings"].includes(params.get("tab")) ? params.get("tab") : "history";
  const expandedTasks = new Set(), taskLimits = new Map();
  let filter = "all", limit = 20, settingsDirty = false, settingsLoaded = false, modelDirty = false, modelLoaded = false, loading = false, reloadAgain = false, toastTimer, refreshTimer;
  let account = params.get("account") || "";
  const statuses = { pending: "待提交", running: "正在提交", submitted: "已提交", blocked: "已屏蔽", preexisting: "原本已屏蔽", failed: "提交失败", uncertain: "结果待核对", undo_pending: "等待取消", undo_running: "正在取消", undo_failed: "取消失败", unblocked: "已取消屏蔽", cancelled: "任务已取消" };
  const pending = h => ["pending", "running", "undo_pending", "undo_running"].includes(h.status);
  const failed = h => ["failed", "undo_failed", "uncertain"].includes(h.status);
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const actionButton = (text, action, className = "subtle") => { const b = el("button", className, text); b.type = "button"; b.onclick = () => run(b, action); return b; };
  const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const date = value => dateFormatter.format(value);
  async function send(type, payload = {}) { const r = await chrome.runtime.sendMessage({ type, ...payload }); if (!r?.ok) throw new Error(r?.error || "无法连接扩展后台。"); return r.data; }
  function toast(text) { $("toast").textContent = text; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, 5500); }
  async function run(button, fn) { button.disabled = true; try { await fn(); } catch (e) { toast(e.message); } finally { button.disabled = false; } }
  function tab(value) {
    currentTab = value;
    for (const name of ["history", "whitelist", "settings"]) $("view-" + name).hidden = name !== value;
    document.querySelectorAll("[data-tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === value)));
    if (state) $("onboarding").hidden = state.settings.configured || value === "settings";
  }
  document.querySelectorAll("[data-tab]").forEach(b => { b.onclick = () => tab(b.dataset.tab); });
  $("connect-now").onclick = () => tab("settings");
  // Only extension-owned manager documents use this preference; it survives popup/drawer closure.
  const noticeKey = "blocksb.whitelist-notice-dismissed";
  try { $("whitelist-notice").hidden = localStorage.getItem(noticeKey) === "1"; }
  catch { $("whitelist-notice").hidden = false; }
  $("dismiss-whitelist-notice").onclick = () => {
    $("whitelist-notice").hidden = true;
    try { localStorage.setItem(noticeKey, "1"); } catch { /* Still dismiss for this view if storage is unavailable. */ }
  };
  document.querySelectorAll("[data-filter]").forEach(b => { b.onclick = () => { filter = b.dataset.filter; limit = 20; document.querySelectorAll("[data-filter]").forEach(n => n.classList.toggle("selected", n === b)); renderHistory(); }; });
  $("history-search").oninput = () => { limit = 20; renderHistory(); };
  $("white-search").oninput = renderWhitelist;
  $("account-filter").onchange = e => { account = e.target.value; limit = 20; renderHistory(); };
  $("show-more").onclick = () => { limit += 20; renderHistory(); };
  $("global-pause").onclick = () => run($("global-pause"), async () => { await send("TOGGLE_PAUSE"); await refresh(); });
  $("resume-services").onclick = () => run($("resume-services"), async () => { await send("RESUME_SERVICES"); await refresh(); toast("已恢复任务。失败记录可以单独重试。"); });

  function empty(parent, title, text) { const n = el("div", "empty"); n.append(el("strong", "", title)); if (text) n.append(el("p", "", text)); parent.append(n); }
  function profileHead(target, status) {
    const header = el("div", "record-head"), identity = el("div", "identity");
    identity.append(el("strong", "", target.name || target.handle), el("span", "", `@${target.handle}`));
    header.append(el("div", "avatar", (target.name || target.handle).slice(0, 1).toUpperCase()), identity);
    if (status) header.append(el("span", `status ${status}`, statuses[status] || status));
    return header;
  }
  /** Group repeated sessions by selected tweet and acting account, keeping legacy records intact. */
  function historyTasks() {
    const groups = new Map();
    const add = (root, owner, created) => {
      const key = `${owner}:${root.id}`;
      if (!groups.has(key)) groups.set(key, { key, account: owner, root, created, rows: [], sessions: [] });
      const group = groups.get(key); group.created = Math.max(group.created || 0, created || 0); return group;
    };
    for (const h of state.history) if (!account || h.account === account) add(h.root, h.account, h.created).rows.push(h);
    for (const session of state.sessions) if ((!account || session.account === account) && (!session.stopped || groups.has(`${session.account}:${session.root.id}`))) add(session.root, session.account, session.created).sessions.push(session);
    return [...groups.values()].sort((a, b) => b.created - a.created);
  }
  function matchesStatus(h) {
    return filter === "all" || filter === "pending" && pending(h) || filter === "failed" && failed(h)
      || filter === "blocked" && ["submitted", "blocked", "preexisting"].includes(h.status)
      || filter === "unblocked" && ["unblocked", "cancelled"].includes(h.status);
  }
  function recordCard(h) {
    const record = el("article", "record"); record.append(profileHead(h.target, h.status));
    record.append(el("div", "quote", h.reply?.text || h.root.text || "原帖含有图片或其他媒体"));
    const explanation = h.reason === "author" ? "原帖作者" : h.reason === "manual" ? "手动加入屏蔽" : `支持概率 ${Math.round((h.decision?.support || 0) * 100)}%`;
    record.append(el("div", "record-meta", `${explanation} · ${date(h.created)}`));
    if (h.error) record.append(el("p", "record-error", h.error));
    const actions = el("div", "record-actions"); actions.append(actionButton("查看原因", () => detail(h), "text-button"));
    if (["submitted", "blocked", "undo_failed"].includes(h.status) && h.owned) actions.append(actionButton("取消屏蔽", () => undo(h)));
    if (h.status === "uncertain") actions.append(actionButton("核对状态", async () => { await send("RECONCILE", { id: h.id }); await refresh(); toast("已核对当前 X 屏蔽状态。"); }));
    if (h.status === "failed" && !h.taskWithdrawn) actions.append(actionButton("重试", async () => { await send("RETRY_JOB", { id: h.id }); await refresh(); }));
    if (["pending", "undo_pending"].includes(h.status)) actions.append(actionButton("取消任务", async () => { await send("CANCEL_JOB", { id: h.id }); await refresh(); }));
    record.append(actions); return record;
  }
  async function undoTask(group) {
    const plan = await send("TASK_UNDO_PREVIEW", { account: group.account, rootId: group.root.id });
    const body = el("div");
    body.append(el("p", "modal-copy", `撤回 @${group.root.handle} 这条推文的整个任务（由 @${group.account} 操作），包括原帖作者和本任务中的评论账号，不受当前搜索或筛选限制。`));
    const numbers = el("div", "task-undo-counts");
    for (const [label, count] of [["加入取消屏蔽队列", plan.ready], ["取消尚未提交请求", plan.cancel], ["请求完成后安排撤回", plan.inFlight], ["已在撤回队列", plan.existing]]) numbers.append(el("p", "", `${label}：${count} 位`));
    body.append(numbers, el("p", "modal-copy", "同时停止这个原帖在所有标签页中的分析。取消屏蔽需要保持同一账号的任意 X 页面打开，无需停留在原帖。"));
    if (plan.review) body.append(el("p", "hint", `${plan.review} 条失败或结果未知的记录需单独处理，不会宣称它们已撤回。`));
    if (plan.protected) body.append(el("p", "hint", `${plan.protected} 条原有屏蔽或由后续记录管理的账号将保留。`));
    body.append(el("p", "hint", "此前只记录 HTTP 成功的屏蔽没有核对原有关系，取消屏蔽会解除账号当前的屏蔽关系。"));
    modal("撤回本任务的屏蔽？", body, async () => {
      const result = await send("UNDO_TASK", { account: group.account, rootId: group.root.id });
      expandedTasks.add(group.key); await refresh();
      toast(`已停止任务：${result.ready} 位加入撤回队列，${result.cancel} 条取消提交，${result.inFlight} 条等待请求返回。`);
    }, "确认撤回本任务");
  }
  function renderHistory() {
    if (!state) return;
    const rows = state.history.filter(h => !account || h.account === account), groups = historyTasks();
    $("history-count").textContent = String(groups.length);
    $("stat-blocked").textContent = String(rows.filter(h => ["blocked", "submitted"].includes(h.status)).length);
    $("stat-pending").textContent = String(rows.filter(pending).length);
    $("stat-review").textContent = String(rows.filter(failed).length);
    const query = $("history-search").value.trim().toLowerCase();
    const selected = groups.map(group => {
      const rootMatch = [group.root.text, group.root.handle, group.root.name, group.account].join(" ").toLowerCase().includes(query);
      return { ...group, matching: group.rows.filter(h => matchesStatus(h) && (rootMatch || [h.target.handle, h.target.name, h.reply?.text].join(" ").toLowerCase().includes(query))), rootMatch };
    }).filter(group => group.matching.length || filter === "all" && group.rootMatch && !group.rows.length);
    const list = $("history-list"); list.replaceChildren();
    $("session-list").replaceChildren();
    for (const group of selected.slice(0, limit)) {
      const card = el("section", "task-card");
      const head = el("div", "task-heading");
      head.append(el("h3", "", `@${group.root.handle} 的推文`));
      const undoing = group.rows.some(h => ["undo_pending", "undo_running"].includes(h.status) || h.undoRequested && h.status === "running");
      const withdrawn = group.rows.length && group.rows.every(h => h.taskWithdrawn);
      const label = undoing ? "撤回中" : withdrawn ? group.rows.some(failed) ? "撤回需处理" : group.rows.every(h => ["unblocked", "cancelled"].includes(h.status)) ? "已撤回" : "已停止任务" : group.sessions.some(s => !s.stopped) ? "任务进行中" : "任务记录";
      head.append(el("span", "status", label)); card.append(head);
      card.append(el("p", "task-root", group.root.text || "原帖包含图片或其他媒体"));
      card.append(el("p", "task-meta", `由 @${group.account} 操作 · ${date(group.created)} · ${group.rows.length} 条记录`));
      const summary = el("div", "task-counts");
      for (const [name, count] of [["已提交 / 屏蔽", group.rows.filter(h => ["submitted", "blocked", "preexisting"].includes(h.status)).length], ["队列中", group.rows.filter(pending).length], ["已撤回 / 取消", group.rows.filter(h => ["unblocked", "cancelled"].includes(h.status)).length], ["需处理", group.rows.filter(failed).length]]) summary.append(el("span", "", `${name} ${count}`));
      card.append(summary);
      const actions = el("div", "task-actions");
      const link = el("a", "text-button", "查看原帖 ↗"); link.href = group.root.url; link.target = "_blank"; link.rel = "noreferrer"; actions.append(link);
      if (group.sessions.some(s => !s.stopped)) actions.append(actionButton("停止任务", async () => {
        await Promise.all(group.sessions.filter(s => !s.stopped).map(s => send("STOP_SESSION", { tabId: s.tabId })));
        await refresh(); toast("任务已停止；已提交的屏蔽保留，可另行整组撤回。");
      }, "text-button"));
      actions.append(actionButton("一键撤回屏蔽", () => undoTask(group), "subtle task-undo"));
      const expanded = expandedTasks.has(group.key);
      const toggle = actionButton(expanded ? "收起明细" : `展开明细 (${group.matching.length})`, () => { if (expandedTasks.has(group.key)) expandedTasks.delete(group.key); else expandedTasks.add(group.key); renderHistory(); }, "text-button");
      toggle.setAttribute("aria-expanded", String(expanded)); actions.append(toggle); card.append(actions);
      if (expanded) {
        const details = el("div", "task-records"), count = taskLimits.get(group.key) || 20;
        if (group.matching.length !== group.rows.length) details.append(el("p", "hint", `当前筛选显示 ${group.matching.length} / ${group.rows.length} 条；一键撤回仍作用于整个任务。`));
        for (const h of group.matching.slice(0, count)) details.append(recordCard(h));
        if (!group.matching.length) details.append(el("p", "hint", "任务尚未产生屏蔽记录。"));
        if (group.matching.length > count) details.append(actionButton("显示更多账号", () => { taskLimits.set(group.key, count + 20); renderHistory(); }, "text-button wide"));
        card.append(details);
      }
      list.append(card);
    }
    if (!selected.length) empty(list, query || filter !== "all" ? "没有匹配的任务" : "暂无屏蔽记录", query || filter !== "all" ? "" : "从 X 帖子菜单启动。");
    $("show-more").hidden = selected.length <= limit;
  }
  function renderWhitelist() {
    if (!state) return;
    $("white-count").textContent = String(state.whitelist.length);
    const list = $("whitelist-list"); list.replaceChildren(); const query = $("white-search").value.toLowerCase().trim();
    const records = state.whitelist.filter(w => [w.handle, w.name, w.note].join(" ").toLowerCase().includes(query));
    for (const w of records) {
      const row = el("article", "record"); row.append(profileHead(w));
      row.append(el("p", "record-meta", w.note || "不分析 · 不自动屏蔽"));
      const actions = el("div", "record-actions");
      actions.append(actionButton("编辑备注", () => editWhite(w), "text-button"), actionButton("移出白名单", () => {
        modal("移出白名单？", `@${w.handle} 的后续评论将重新按当前策略判断，已有的屏蔽不会因此改变。`, async () => { await send("WHITELIST_REMOVE", { handle: w.handle }); await refresh(); }, "移出");
      })); row.append(actions); list.append(row);
    }
    if (!records.length) empty(list, query ? "没有匹配的用户" : "暂无白名单");
  }
  function modal(title, copy, confirm, confirmLabel = "确认") {
    $("modal-title").textContent = title; $("modal-body").replaceChildren(); $("modal-actions").replaceChildren();
    if (typeof copy === "string") $("modal-body").append(el("p", "modal-copy", copy)); else if (copy) $("modal-body").append(copy);
    $("modal-actions").append(actionButton("返回", () => $("modal").close(), "subtle"));
    if (confirm) $("modal-actions").append(actionButton(confirmLabel, async () => { await confirm(); $("modal").close(); }, "primary"));
    if (!$("modal").open) $("modal").showModal();
  }
  $("modal-close").onclick = () => $("modal").close();
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("modal").open && params.has("embedded")) parent.postMessage({ type: "blocksb:close" }, "*"); });
  function undo(h) {
    const body = el("div"); body.append(el("p", "modal-copy", `将使用 @${h.account} 的 X 登录状态取消对 @${h.target.handle} 的屏蔽。请保持该账号的 X 页面打开。该用户不会在当前任务中再次被自动屏蔽。`));
    if (h.verification === "http-only") body.append(el("p", "hint", "这条记录只确认了屏蔽请求的 HTTP 成功响应，未查询此前是否已经屏蔽。取消屏蔽会解除该账号当前的屏蔽关系。"));
    const label = el("label", "modal-check"), input = el("input"); input.type = "checkbox"; label.append(input, document.createTextNode("同时加入白名单，以后也不再分析")); body.append(label);
    modal("取消屏蔽", body, async () => { await send("UNDO", { id: h.id, whitelist: input.checked }); await refresh(); toast("取消屏蔽已加入队列。"); }, "取消屏蔽");
  }
  function detail(h) {
    const body = el("div"); body.append(profileHead(h.target, h.status));
    if (h.verification === "http-only") body.append(el("p", "hint", "屏蔽请求已收到 HTTP 成功响应；未进行屏蔽关系查询。"));
    body.append(el("p", "detail-label", "选中的原帖"), el("p", "detail-text", h.root.text || "无可读取文本"));
    if (h.reply) body.append(el("p", "detail-label", "触发判断的评论"), el("p", "detail-text", h.reply.text));
    if (h.decision) {
      const grid = el("div", "detail-grid");
      for (const [label, value] of [["支持概率", `${Math.round(h.decision.support * 100)}%`], ["模型置信度", `${Math.round(h.decision.confidence * 100)}%`], ["模型", h.decision.model], ["分类", h.decision.label]]) { const item = el("div"); item.append(el("span", "", label), el("p", "", value)); grid.append(item); }
      body.append(el("p", "detail-label", "判断依据"), grid);
    } else body.append(el("p", "modal-copy", h.reason === "manual" ? "你通过评论旁的按钮主动加入屏蔽，未经过模型判断。" : "此账号是你主动选择屏蔽的原作者，未经过模型判断。"));
    if (h.error) body.append(el("p", "record-error", h.error));
    const link = el("a", "text-button", "查看 X 原帖 ↗"); link.href = h.root.url; link.target = "_blank"; link.rel = "noreferrer"; body.append(el("p", "detail-label", `记录时间 ${date(h.created)}`), link);
    modal("为什么处理这位用户", body);
    $("modal-actions").prepend(actionButton("加入白名单", async () => { await send("WHITELIST_ADD", h.target); await refresh(); toast("已加入白名单。已有屏蔽可在记录中取消。"); $("modal").close(); }, "text-button"));
  }
  function editWhite(w) {
    const input = el("input"); input.value = w.note || ""; input.maxLength = 100; input.setAttribute("aria-label", "备注");
    modal(`@${w.handle} 的备注`, input, async () => { await send("WHITELIST_ADD", { ...w, note: input.value }); await refresh(); }, "保存");
  }
  $("whitelist-form").onsubmit = e => { e.preventDefault(); run(e.submitter, async () => { await send("WHITELIST_ADD", { handle: $("white-handle").value, note: $("white-note").value }); e.target.reset(); await refresh(); toast("已加入白名单。"); }); };
  function updateKeyRequirement() {
    let changedOrigin = false;
    try { changedOrigin = new URL(normalizeEndpoint($("api-endpoint").value)).origin !== new URL(state.settings.endpoint || DEFAULT_ENDPOINT).origin; } catch { /* Form/backend validation reports invalid endpoints. */ }
    $("api-key").required = !state?.settings.configured || changedOrigin;
    $("api-key").placeholder = changedOrigin ? "输入该服务的 API Key" : state?.settings.configured ? "留空沿用已保存的 Key" : "输入 API Key";
  }
  $("key-form").oninput = () => { modelDirty = true; $("model-feedback").textContent = "有未保存的更改"; updateKeyRequirement(); };
  $("reset-prompt").onclick = () => { $("custom-prompt").value = DEFAULT_STANCE_PROMPT; modelDirty = true; $("model-feedback").textContent = "已恢复默认，保存后生效"; };
  $("key-form").onsubmit = e => { e.preventDefault(); run($("save-key"), async () => {
    const next = updateSettings(state.settings, { endpoint: $("api-endpoint").value, model: $("model").value, customPrompt: $("custom-prompt").value });
    const config = { endpoint: next.endpoint, model: next.model, customPrompt: next.customPrompt };
    const secret = $("api-key").value;
    // Request only the chosen host, directly within this user gesture (before any await).
    const permission = chrome.permissions.request({ origins: [endpointPermission(config.endpoint)] });
    $("save-key").textContent = "连接中…";
    const fields = [...$("key-form").querySelectorAll("input, textarea, button")].filter(n => n.id !== "save-key");
    fields.forEach(n => { n.disabled = true; });
    try {
      if (!await permission) throw new Error("未授权访问该 API 端点，配置未保存。");
      await send("SAVE_MODEL_CONFIG", { value: secret, config });
      $("api-key").value = ""; $("api-key").type = "password"; $("reveal-key").textContent = "显示";
      modelDirty = false; modelLoaded = false; await refresh(); $("model-feedback").textContent = "已保存并连接";
    } finally { fields.forEach(n => { n.disabled = false; }); $("save-key").textContent = "保存并连接"; }
  }); };
  $("reveal-key").onclick = () => { const reveal = $("api-key").type === "password"; $("api-key").type = reveal ? "text" : "password"; $("reveal-key").textContent = reveal ? "隐藏" : "显示"; };
  $("remove-key").onclick = () => modal("移除 Jev 密钥？", "新的评论分析将停止，屏蔽记录和白名单仍会保留。", async () => { await send("REMOVE_KEY"); await refresh(); }, "移除密钥");
  $("settings-form").oninput = () => { settingsDirty = true; $("settings-feedback").textContent = "有未保存的更改"; };
  function updateMaskRange() {
    $("maskThreshold").max = Number($("high").value) - 1;
    $("maskThreshold").value = Math.min(Number($("maskThreshold").value), Number($("maskThreshold").max));
    $("maskThreshold-out").textContent = `${$("maskThreshold").value}%`;
    $("maskThreshold").disabled = !$("mask-enabled").checked;
    $("mask-range").textContent = $("mask-enabled").checked ? `隐藏区间：${$("maskThreshold").value}% ≤ 支持概率 < ${$("high").value}%` : "";
  }
  $("mask-enabled").onchange = updateMaskRange;
  const updateAnimationOptions = () => { $("animation-effects").disabled = !$("animation").checked; };
  $("animation").onchange = updateAnimationOptions;
  for (const key of ["high", "confidence", "maskThreshold"]) $(key).oninput = () => { $(key + "-out").textContent = `${$(key).value}%`; if (key !== "maskThreshold") document.querySelector('[name="preset"][value="custom"]').checked = true; updateMaskRange(); };
  document.querySelectorAll('[name="preset"]').forEach(input => { input.onchange = () => { const p = state.presets[input.value]; if (p) for (const key of ["high", "confidence"]) { $(key).value = Math.round(p[key] * 100); $(key + "-out").textContent = `${$(key).value}%`; } updateMaskRange(); }; });
  $("settings-form").onsubmit = e => { e.preventDefault(); run(e.submitter, async () => {
    await send("SAVE_SETTINGS", { value: { preset: document.querySelector('[name="preset"]:checked').value, high: Number($("high").value) / 100, confidence: Number($("confidence").value) / 100, maskEnabled: $("mask-enabled").checked, maskThreshold: Number($("maskThreshold").value) / 100, cacheLimit: Number($("cache-limit").value), animation: $("animation").checked, animationEffect: document.querySelector('[name="animation-effect"]:checked').value, reducedMotion: $("reduced-motion").checked } });
    settingsDirty = false; settingsLoaded = false; await refresh(); $("settings-feedback").textContent = "已保存";
  }); };
  $("export").onclick = () => run($("export"), async () => { const data = await send("EXPORT"); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); const link = el("a"); link.href = url; link.download = `block-sb-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); });
  $("clear-finished").onclick = () => modal("清理已取消的记录？", "仅清理已取消屏蔽和已取消任务的本地记录。当前已屏蔽的账号及其撤销入口会保留。此操作不会改变 X 上的屏蔽关系。", async () => { await send("CLEAR_FINISHED"); await refresh(); }, "清理记录");

  async function refresh() {
    if (loading) { reloadAgain = true; return; }
    loading = true;
    try {
      const previousRevision = state?.settings.analysisRevision;
      state = await send("SNAPSHOT");
      if (previousRevision !== state.settings.analysisRevision) modelLoaded = false;
      $("global-pause").textContent = state.settings.paused ? "继续" : "暂停";
      $("onboarding").hidden = state.settings.configured || currentTab === "settings";
      $("service-error").hidden = !(state.queueError || state.queueNotice || state.modelError);
      $("service-error-text").textContent = [state.modelError, state.queueError, state.queueNotice].filter(Boolean).join(" ");
      $("key-status").textContent = state.settings.configured ? "已配置" : "未连接";
      $("key-status").className = `status ${state.settings.configured ? "connected" : ""}`;
      $("remove-key").hidden = !state.settings.configured;
      if (!modelLoaded && !modelDirty) {
        $("api-endpoint").value = state.settings.endpoint || DEFAULT_ENDPOINT;
        $("model").value = state.settings.model;
        $("custom-prompt").value = state.settings.customPrompt || DEFAULT_STANCE_PROMPT;
        modelLoaded = true;
      }
      updateKeyRequirement();
      const accounts = [...new Set([...state.history.map(h => h.account), ...state.sessions.map(s => s.account), ...(account ? [account] : [])])].sort();
      const options = $("account-filter"); options.replaceChildren(new Option("全部账号", ""), ...accounts.map(a => new Option(`@${a}`, a))); options.value = account;
      if (!settingsLoaded && !settingsDirty) {
        $("maskThreshold").max = 100;
        for (const key of ["high", "confidence", "maskThreshold"]) { $(key).value = Math.round(state.settings[key] * 100); $(key + "-out").textContent = `${$(key).value}%`; }
        $("mask-enabled").checked = state.settings.maskEnabled; $("cache-limit").value = state.settings.cacheLimit; updateMaskRange();
        document.querySelector(`[name="preset"][value="${state.settings.preset}"]`).checked = true;
        $("animation").checked = state.settings.animation; $("reduced-motion").checked = state.settings.reducedMotion; settingsLoaded = true;
        document.querySelector(`[name="animation-effect"][value="${state.settings.animationEffect === "particles" ? "particles" : "fly"}"]`).checked = true;
        updateAnimationOptions();
      }
      renderHistory(); renderWhitelist();
    } catch (e) { toast(e.message); }
    finally { loading = false; if (reloadAgain) { reloadAgain = false; void refresh(); } }
  }
  chrome.runtime.onMessage.addListener(m => { if (m?.type === "STATE_CHANGED") { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); } });
  tab(currentTab); void refresh();
})();
