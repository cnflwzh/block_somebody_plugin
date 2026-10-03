import "../lib/i18n.js";
const { t, locale, localizeDocument } = globalThis.BlockSBI18n;
import { DEFAULT_ENDPOINT, normalizeEndpoint, endpointPermission, updateSettings, getAnalysisRule, customRuleEnabled } from "../lib/core.js";
localizeDocument(document);

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
  const statuses = { pending: t("ui_pending"), running: t("ui_submitting"), submitted: t("ui_submitted"), blocked: t("ui_blocked"), preexisting: t("ui_already_blocked"), failed: t("ui_submission_failed"), uncertain: t("ui_needs_verification"), undo_pending: t("ui_unblock_pending"), undo_running: t("ui_unblocking"), undo_failed: t("ui_unblock_failed"), unblocked: t("ui_unblocked"), cancelled: t("ui_task_canceled") };
  const pending = h => ["pending", "running", "undo_pending", "undo_running"].includes(h.status);
  const failed = h => ["failed", "undo_failed", "uncertain"].includes(h.status);
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const actionButton = (text, action, className = "subtle") => { const b = el("button", className, text); b.type = "button"; b.onclick = () => run(b, action); return b; };
  const dateFormatter = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const date = value => dateFormatter.format(value);
  async function send(type, payload = {}) { const r = await chrome.runtime.sendMessage({ type, ...payload }); if (!r?.ok) throw new Error(r?.error || t("ui_cannot_connect_to_the_extension")); return r.data; }
  function toast(text) { $("toast").textContent = String(text); $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, 5500); }
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
  $("resume-services").onclick = () => run($("resume-services"), async () => { await send("RESUME_SERVICES"); await refresh(); toast(t("ui_tasks_resumed_failed_items_can_be_retried_individually")); });

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
    record.append(el("div", "quote", h.reply?.text || h.root.text || t("ui_the_original_post_contains_media")));
    const explanation = h.reason === "author" ? t("ui_original_author") : h.reason === "manual" ? t("ui_blocked_manually") : `${h.decision?.customRule ? t("match_probability") : t("support_probability")} ${Math.round((h.decision?.support || 0) * 100)}%`;
    record.append(el("div", "record-meta", `${explanation} · ${date(h.created)}`));
    if (h.error) record.append(el("p", "record-error", String(h.error)));
    const actions = el("div", "record-actions"); actions.append(actionButton(t("ui_view_reason"), () => detail(h), "text-button"));
    if (["submitted", "blocked", "undo_failed"].includes(h.status) && h.owned) actions.append(actionButton(t("ui_unblock"), () => undo(h)));
    if (h.status === "uncertain") actions.append(actionButton(t("ui_verify_status"), async () => { await send("RECONCILE", { id: h.id }); await refresh(); toast(t("ui_current_block_status_on_x_verified")); }));
    if (h.status === "failed" && !h.taskWithdrawn) actions.append(actionButton(t("ui_retry"), async () => { await send("RETRY_JOB", { id: h.id }); await refresh(); }));
    if (["pending", "undo_pending"].includes(h.status)) actions.append(actionButton(t("ui_cancel_task"), async () => { await send("CANCEL_JOB", { id: h.id }); await refresh(); }));
    record.append(actions); return record;
  }
  async function undoTask(group) {
    const plan = await send("TASK_UNDO_PREVIEW", { account: group.account, rootId: group.root.id });
    const body = el("div");
    body.append(el("p", "modal-copy", t("ui_undo_this_entire_task_for_s_post_using_includes_the", group.root.handle, group.account)));
    const numbers = el("div", "task-undo-counts");
    for (const [label, count] of [[t("ui_queue_for_unblocking"), plan.ready], [t("ui_cancel_unsent_requests"), plan.cancel], [t("ui_undo_after_request_completes"), plan.inFlight], [t("ui_already_queued_for_undo"), plan.existing]]) numbers.append(el("p", "", t("ui_accounts", label, count)));
    body.append(numbers, el("p", "modal-copy", t("ui_also_stops_analysis_of_this_post_in_all_tabs_to")));
    if (plan.review) body.append(el("p", "hint", t("ui_failed_or_unconfirmed_items_need_separate_review_they_will_not", plan.review)));
    if (plan.protected) body.append(el("p", "hint", t("ui_existing_blocks_or_accounts_managed_by_later_records_will_be", plan.protected)));
    body.append(el("p", "hint", t("ui_for_http_only_records_the_previous_block_status_was_not")));
    modal(t("ui_undo_this_task_s_blocks"), body, async () => {
      const result = await send("UNDO_TASK", { account: group.account, rootId: group.root.id });
      expandedTasks.add(group.key); await refresh();
      toast(t("ui_task_stopped_accounts_queued_for_undo_unsent_requests_canceled_requests", result.ready, result.cancel, result.inFlight));
    }, t("ui_undo_task"));
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
      head.append(el("h3", "", t("ui_post_by", group.root.handle)));
      const undoing = group.rows.some(h => ["undo_pending", "undo_running"].includes(h.status) || h.undoRequested && h.status === "running");
      const withdrawn = group.rows.length && group.rows.every(h => h.taskWithdrawn);
      const label = undoing ? t("ui_undoing") : withdrawn ? group.rows.some(failed) ? t("ui_undo_needs_attention") : group.rows.every(h => ["unblocked", "cancelled"].includes(h.status)) ? t("ui_undone") : t("ui_task_stopped") : group.sessions.some(s => !s.stopped) ? t("ui_task_running") : t("ui_task_history");
      head.append(el("span", "status", label)); card.append(head);
      card.append(el("p", "task-root", group.root.text || t("ui_the_original_post_contains_media_2")));
      card.append(el("p", "task-meta", t("ui_via_records", group.account, date(group.created), group.rows.length)));
      const summary = el("div", "task-counts");
      for (const [name, count] of [[t("ui_submitted_blocked"), group.rows.filter(h => ["submitted", "blocked", "preexisting"].includes(h.status)).length], [t("ui_queued"), group.rows.filter(pending).length], [t("ui_undone_canceled"), group.rows.filter(h => ["unblocked", "cancelled"].includes(h.status)).length], [t("ui_needs_attention"), group.rows.filter(failed).length]]) summary.append(el("span", "", `${name} ${count}`));
      card.append(summary);
      const actions = el("div", "task-actions");
      const link = el("a", "text-button", t("ui_view_original")); link.href = group.root.url; link.target = "_blank"; link.rel = "noreferrer"; actions.append(link);
      if (group.sessions.some(s => !s.stopped)) actions.append(actionButton(t("ui_stop_task"), async () => {
        await Promise.all(group.sessions.filter(s => !s.stopped).map(s => send("STOP_SESSION", { tabId: s.tabId })));
        await refresh(); toast(t("ui_task_stopped_submitted_blocks_remain_use_undo_all_blocks_to"));
      }, "text-button"));
      actions.append(actionButton(t("ui_undo_all_blocks"), () => undoTask(group), "subtle task-undo"));
      const expanded = expandedTasks.has(group.key);
      const toggle = actionButton(expanded ? t("ui_hide_details") : t("ui_show_details", group.matching.length), () => { if (expandedTasks.has(group.key)) expandedTasks.delete(group.key); else expandedTasks.add(group.key); renderHistory(); }, "text-button");
      toggle.setAttribute("aria-expanded", String(expanded)); actions.append(toggle); card.append(actions);
      if (expanded) {
        const details = el("div", "task-records"), count = taskLimits.get(group.key) || 20;
        if (group.matching.length !== group.rows.length) details.append(el("p", "hint", t("ui_showing_of_records_undo_still_applies_to_the_entire_task", group.matching.length, group.rows.length)));
        for (const h of group.matching.slice(0, count)) details.append(recordCard(h));
        if (!group.matching.length) details.append(el("p", "hint", t("ui_no_blocks_recorded_for_this_task_yet")));
        if (group.matching.length > count) details.append(actionButton(t("ui_show_more_accounts"), () => { taskLimits.set(group.key, count + 20); renderHistory(); }, "text-button wide"));
        card.append(details);
      }
      list.append(card);
    }
    if (!selected.length) empty(list, query || filter !== "all" ? t("ui_no_matching_tasks") : t("ui_no_block_history_yet"), query || filter !== "all" ? "" : t("ui_start_from_a_post_s_menu_on_x"));
    $("show-more").hidden = selected.length <= limit;
  }
  function renderWhitelist() {
    if (!state) return;
    $("white-count").textContent = String(state.whitelist.length);
    const list = $("whitelist-list"); list.replaceChildren(); const query = $("white-search").value.toLowerCase().trim();
    const records = state.whitelist.filter(w => [w.handle, w.name, w.note].join(" ").toLowerCase().includes(query));
    for (const w of records) {
      const row = el("article", "record"); row.append(profileHead(w));
      row.append(el("p", "record-meta", w.note || t("ui_no_analysis_no_automatic_blocking")));
      const actions = el("div", "record-actions");
      actions.append(actionButton(t("ui_edit_note"), () => editWhite(w), "text-button"), actionButton(t("ui_remove_from_allowlist"), () => {
        modal(t("ui_remove_from_allowlist_2"), t("ui_future_replies_by_will_follow_the_current_rules_existing_blocks", w.handle), async () => { await send("WHITELIST_REMOVE", { handle: w.handle }); await refresh(); }, t("ui_remove"));
      })); row.append(actions); list.append(row);
    }
    if (!records.length) empty(list, query ? t("ui_no_matching_users") : t("ui_allowlist_is_empty"));
  }
  function modal(title, copy, confirm, confirmLabel = t("ui_confirm")) {
    $("modal-title").textContent = title; $("modal-body").replaceChildren(); $("modal-actions").replaceChildren();
    if (typeof copy === "string") $("modal-body").append(el("p", "modal-copy", copy)); else if (copy) $("modal-body").append(copy);
    $("modal-actions").append(actionButton(t("ui_back"), () => $("modal").close(), "subtle"));
    if (confirm) $("modal-actions").append(actionButton(confirmLabel, async () => { await confirm(); $("modal").close(); }, "primary"));
    if (!$("modal").open) $("modal").showModal();
  }
  $("modal-close").onclick = () => $("modal").close();
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("modal").open && params.has("embedded")) parent.postMessage({ type: "blocksb:close" }, "*"); });
  function undo(h) {
    const body = el("div"); body.append(el("p", "modal-copy", t("ui_use_s_x_session_to_unblock_keep_an_x_page", h.account, h.target.handle)));
    if (h.verification === "http-only") body.append(el("p", "hint", t("ui_only_http_success_was_recorded_the_prior_block_status_was")));
    const label = el("label", "modal-check"), input = el("input"); input.type = "checkbox"; label.append(input, document.createTextNode(t("ui_also_allowlist_this_user_to_skip_future_analysis"))); body.append(label);
    modal(t("ui_unblock"), body, async () => { await send("UNDO", { id: h.id, whitelist: input.checked }); await refresh(); toast(t("ui_unblock_request_queued")); }, t("ui_unblock"));
  }
  function detail(h) {
    const body = el("div"); body.append(profileHead(h.target, h.status));
    if (h.verification === "http-only") body.append(el("p", "hint", t("ui_block_request_received_an_http_success_response_the_relationship_was")));
    body.append(el("p", "detail-label", t("ui_selected_original_post")), el("p", "detail-text", h.root.text || t("ui_no_readable_text")));
    if (h.reply) body.append(el("p", "detail-label", t("ui_reply_that_triggered_the_decision")), el("p", "detail-text", h.reply.text));
    if (h.decision) {
      const grid = el("div", "detail-grid");
      const labelName = !h.decision.customRule && ["support", "oppose", "neutral", "uncertain"].includes(h.decision.label)
        ? t(`category_${h.decision.label}`) : h.decision.labelName || h.decision.label;
      for (const [label, value] of [[h.decision.customRule ? t("match_probability") : t("support_probability"), `${Math.round(h.decision.support * 100)}%`], [t("model_confidence"), `${Math.round(h.decision.confidence * 100)}%`], [t("ui_model"), h.decision.model], [t("ui_category"), labelName]]) { const item = el("div"); item.append(el("span", "", label), el("p", "", value)); grid.append(item); }
      body.append(el("p", "detail-label", t("ui_decision_details")), grid);
      if (h.decision.labelDescription) body.append(el("p", "detail-text", h.decision.labelDescription));
    } else body.append(el("p", "modal-copy", h.reason === "manual" ? t("ui_you_manually_blocked_this_user_using_the_reply_button_no") : t("ui_you_chose_to_block_the_original_author_no_model_decision")));
    if (h.error) body.append(el("p", "record-error", String(h.error)));
    const link = el("a", "text-button", t("ui_view_post_on_x")); link.href = h.root.url; link.target = "_blank"; link.rel = "noreferrer"; body.append(el("p", "detail-label", t("ui_recorded", date(h.created))), link);
    modal(t("ui_why_this_user_was_processed"), body);
    $("modal-actions").prepend(actionButton(t("ui_add_to_allowlist"), async () => { await send("WHITELIST_ADD", h.target); await refresh(); toast(t("ui_added_to_allowlist_existing_blocks_can_be_undone_in_history")); $("modal").close(); }, "text-button"));
  }
  function editWhite(w) {
    const input = el("input"); input.value = w.note || ""; input.maxLength = 100; input.setAttribute("aria-label", t("ui_note"));
    modal(t("ui_note_for", w.handle), input, async () => { await send("WHITELIST_ADD", { ...w, note: input.value }); await refresh(); }, t("ui_save"));
  }
  $("whitelist-form").onsubmit = e => { e.preventDefault(); run(e.submitter, async () => { await send("WHITELIST_ADD", { handle: $("white-handle").value, note: $("white-note").value }); e.target.reset(); await refresh(); toast(t("ui_added_to_allowlist")); }); };
  function updateKeyRequirement() {
    let changedOrigin = false;
    try { changedOrigin = new URL(normalizeEndpoint($("api-endpoint").value)).origin !== new URL(state.settings.endpoint || DEFAULT_ENDPOINT).origin; } catch { /* Form/backend validation reports invalid endpoints. */ }
    $("api-key").required = !state?.settings.configured || changedOrigin;
    $("api-key").placeholder = changedOrigin ? t("ui_enter_this_service_s_api_key") : state?.settings.configured ? t("ui_leave_blank_to_keep_the_saved_key") : t("ui_enter_api_key");
  }
  $("key-form").oninput = () => { modelDirty = true; $("model-feedback").textContent = t("ui_unsaved_changes"); updateKeyRequirement(); };
  $("edit-rules").onclick = () => run($("edit-rules"), () => send("OPEN_RULE_EDITOR"));
  $("key-form").onsubmit = e => { e.preventDefault(); run($("save-key"), async () => {
    const next = updateSettings(state.settings, { endpoint: $("api-endpoint").value, model: $("model").value });
    const config = { endpoint: next.endpoint, model: next.model };
    const secret = $("api-key").value;
    // Request only the chosen host, directly within this user gesture (before any await).
    const permission = chrome.permissions.request({ origins: [endpointPermission(config.endpoint)] });
    $("save-key").textContent = t("ui_connecting");
    const fields = [...$("key-form").querySelectorAll("input, textarea, button")].filter(n => n.id !== "save-key");
    fields.forEach(n => { n.disabled = true; });
    try {
      if (!await permission) throw new Error(t("ui_access_to_this_api_endpoint_was_not_granted_settings_were"));
      await send("SAVE_MODEL_CONFIG", { value: secret, config });
      $("api-key").value = ""; $("api-key").type = "password"; $("reveal-key").textContent = t("ui_show");
      modelDirty = false; modelLoaded = false; await refresh(); $("model-feedback").textContent = t("ui_saved_and_connected");
    } finally { fields.forEach(n => { n.disabled = false; }); $("save-key").textContent = t("ui_save_and_connect"); }
  }); };
  $("reveal-key").onclick = () => { const reveal = $("api-key").type === "password"; $("api-key").type = reveal ? "text" : "password"; $("reveal-key").textContent = reveal ? t("ui_hide") : t("ui_show"); };
  $("remove-key").onclick = () => modal(t("ui_remove_jev_api_key"), t("ui_new_analysis_will_stop_block_history_and_the_allowlist_will"), async () => { await send("REMOVE_KEY"); await refresh(); }, t("ui_remove_key"));
  $("settings-form").oninput = () => { settingsDirty = true; $("settings-feedback").textContent = t("ui_unsaved_changes"); };
  function updateMaskRange() {
    $("maskThreshold").max = Number($("high").value) - 1;
    $("maskThreshold").value = Math.min(Number($("maskThreshold").value), Number($("maskThreshold").max));
    $("maskThreshold-out").textContent = `${$("maskThreshold").value}%`;
    $("maskThreshold").disabled = !$("mask-enabled").checked;
    $("mask-range").textContent = $("mask-enabled").checked ? t("ui_hide_range", $("maskThreshold").value, customRuleEnabled(state.settings) ? t("match_probability") : t("support_probability"), $("high").value) : "";
  }
  $("mask-enabled").onchange = updateMaskRange;
  const updateAnimationOptions = () => { $("animation-effects").disabled = !$("animation").checked; };
  $("animation").onchange = updateAnimationOptions;
  for (const key of ["high", "confidence", "maskThreshold"]) $(key).oninput = () => { $(key + "-out").textContent = `${$(key).value}%`; if (key !== "maskThreshold") document.querySelector('[name="preset"][value="custom"]').checked = true; updateMaskRange(); };
  document.querySelectorAll('[name="preset"]').forEach(input => { input.onchange = () => { const p = state.presets[input.value]; if (p) for (const key of ["high", "confidence"]) { $(key).value = Math.round(p[key] * 100); $(key + "-out").textContent = `${$(key).value}%`; } updateMaskRange(); }; });
  $("settings-form").onsubmit = e => { e.preventDefault(); run(e.submitter, async () => {
    await send("SAVE_SETTINGS", { value: { preset: document.querySelector('[name="preset"]:checked').value, high: Number($("high").value) / 100, confidence: Number($("confidence").value) / 100, skipFollowing: $("skip-following").checked, maskEnabled: $("mask-enabled").checked, maskThreshold: Number($("maskThreshold").value) / 100, cacheLimit: Number($("cache-limit").value), animation: $("animation").checked, animationEffect: document.querySelector('[name="animation-effect"]:checked').value, reducedMotion: $("reduced-motion").checked } });
    settingsDirty = false; settingsLoaded = false; await refresh(); $("settings-feedback").textContent = t("ui_saved");
  }); };
  $("export").onclick = () => run($("export"), async () => { const data = await send("EXPORT"); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); const link = el("a"); link.href = url; link.download = `block-sb-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); });
  $("clear-finished").onclick = () => modal(t("ui_clear_canceled_records"), t("ui_only_unblocked_or_canceled_local_records_will_be_deleted_active"), async () => { await send("CLEAR_FINISHED"); await refresh(); }, t("ui_clear_records"));

  async function refresh() {
    if (loading) { reloadAgain = true; return; }
    loading = true;
    try {
      const previousRevision = state?.settings.analysisRevision;
      state = await send("SNAPSHOT");
      if (previousRevision !== state.settings.analysisRevision) modelLoaded = false;
      $("global-pause").textContent = state.settings.paused ? t("resume") : t("pause");
      $("onboarding").hidden = state.settings.configured || currentTab === "settings";
      $("service-error").hidden = !(state.queueError || state.queueNotice || state.modelError);
      $("service-error-text").textContent = [state.modelError, state.queueError, state.queueNotice].filter(Boolean).map(value => String(value)).join(" ");
      $("key-status").textContent = state.settings.configured ? t("ui_configured") : t("ui_not_connected");
      $("key-status").className = `status ${state.settings.configured ? "connected" : ""}`;
      $("remove-key").hidden = !state.settings.configured;
      if (!modelLoaded && !modelDirty) {
        $("api-endpoint").value = state.settings.endpoint || DEFAULT_ENDPOINT;
        $("model").value = state.settings.model;
        modelLoaded = true;
      }
      const rule = getAnalysisRule(state.settings), probabilityLabel = customRuleEnabled(state.settings) ? t("match_probability") : t("support_probability");
      $("rule-summary").textContent = t("ui_options_blocking_options", rule.options.length, rule.options.filter(o => o.block).length);
      document.querySelectorAll(".probability-label").forEach(n => { n.textContent = probabilityLabel; });
      updateMaskRange();
      updateKeyRequirement();
      const accounts = [...new Set([...state.history.map(h => h.account), ...state.sessions.map(s => s.account), ...(account ? [account] : [])])].sort();
      const options = $("account-filter"); options.replaceChildren(new Option(t("ui_all_accounts"), ""), ...accounts.map(a => new Option(`@${a}`, a))); options.value = account;
      if (!settingsLoaded && !settingsDirty) {
        $("maskThreshold").max = 100;
        for (const key of ["high", "confidence", "maskThreshold"]) { $(key).value = Math.round(state.settings[key] * 100); $(key + "-out").textContent = `${$(key).value}%`; }
        $("skip-following").checked = state.settings.skipFollowing; $("mask-enabled").checked = state.settings.maskEnabled; $("cache-limit").value = state.settings.cacheLimit; updateMaskRange();
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
