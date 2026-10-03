(() => {
  const { t, locale } = globalThis.BlockSBI18n;
  const metadata = new Map(), busy = new Set(), skipped = new Map(), rowState = new WeakMap(), manualPending = new Set();
  const contextPosts = new Map(), savedContext = new Map(), requestedContext = new Set();
  let contextFlight = null, contextRetryAt = 0, contextError = "";
  let contextRevision = 0, syncedContextRevision = -1;
  const maskState = new WeakMap(), revealedMasks = new Set();
  const timelineState = new Map();
  const whiteHandles = new Set(), whiteIds = new Set(), historyHandles = new Map(), historyIds = new Map();
  const followingUsers = new Map();
  let followingAccount = "";
  const movingRows = new Set(), played = new Set(), reportedFailures = new Set(), debugRows = new Map();
  const simulatedHandles = new Map();
  let debugVisible = false, debugBusy = false;
  let animationDebug = false, debugEffect = "fly", debugRoute = "", anchorUsers = 0, anchorStyle;
  let pageReady = false, sortFlow = null, loadNote = "", lastSortNote = "", autoAt = 0, loadWait = null, autoStopping = false;
  const openedSpam = new WeakSet();
  let state = null, menuTarget = null, menuTrigger = null, timer, refreshTimer, refreshing = false, refreshAgain = false, lastLocation = "", sessionId = "", failure = "", drawerOpen = false;
  let locationSending = false, locationRetryAt = 0, locationError = "";
  const route = () => location.pathname.match(/^\/\w+\/status\/(\d+)/)?.[1] || "";
  const viewer = () => globalThis.BlockSBX.viewer();
  // A saved, unfinished task proves explicit activation in this tab; pause retains its controls.
  const featureEnabled = () => !!(state?.session && !state.session.stopped && state.session.account === viewer());
  const threadEnabled = () => featureEnabled() && route() === state.session.root.id;
  const white = p => whiteHandles.has(p.handle) || !!(p.userId && whiteIds.has(p.userId));
  function followingStatus(p) {
    const account = viewer();
    let latest = p.followingAccount === account && typeof p.following === "boolean" ? p : null;
    const keys = [p.userId && `id:${p.userId}`, `handle:${p.handle}`].filter(Boolean);
    for (const key of keys) for (const entry of [followingAccount === account && followingUsers.get(key), state?.session?.account === account && state.session.following?.[key]]) {
      if (entry && (!p.userId || !entry.userId || p.userId === entry.userId) && (!latest || entry.followingAt >= latest.followingAt)) latest = entry;
    }
    return latest?.following ?? null;
  }
  const skipFollowing = p => state?.settings.skipFollowing && followingStatus(p) !== false;
  const hasDecision = p => {
    const result = state?.session?.results[p.id];
    return result && (result.error || !state.decisionVersion || result.decisionVersion === state.decisionVersion);
  };
  // Read the latest account relationship (including undo), but scope DOM hiding separately to its task.
  const historyFor = (p, account = viewer()) => {
    if (!state || state.account !== account) return null;
    if (state.settings.debugDryRun && threadEnabled() && simulatedHandles.has(p.handle)) return simulatedHandles.get(p.handle);
    const handle = historyHandles.get(p.handle), id = p.userId && historyIds.get(p.userId);
    return (id && (!handle || id.order > handle.order) ? id : handle)?.entry;
  };
  /** Rebuild once per snapshot, not once per comment. Preserve findLast ordering even after renames. */
  function indexSnapshot() {
    simulatedHandles.clear();
    if (state.session?.dryRun && state.session.authorSimulatedAt) simulatedHandles.set(state.session.root.handle,
      { id: `debug:${state.session.id}:author`, status: "blocked", rootId: state.session.root.id, updated: state.session.authorSimulatedAt });
    if (state.session?.dryRun) for (const [postId, result] of Object.entries(state.session.results)) {
      if (result.dryRun && result.action === "block" && result.handle) simulatedHandles.set(result.handle,
        { id: `debug:${state.session.id}:${postId}`, status: "blocked", rootId: state.session.root.id, updated: result.simulatedAt || Date.now() });
    }
    whiteHandles.clear(); whiteIds.clear(); historyHandles.clear(); historyIds.clear();
    for (const w of state.whitelist) { whiteHandles.add(w.handle); if (w.userId) whiteIds.add(w.userId); }
    state.history.forEach((entry, order) => {
      const value = { entry, order };
      historyHandles.set(entry.target.handle, value);
      if (entry.target.userId) historyIds.set(entry.target.userId, value);
    });
  }
  const isBlocked = h => h && ["submitted", "blocked", "preexisting", "undo_pending", "undo_running", "undo_failed"].includes(h.status);
  const send = async (type, payload = {}) => {
    // Animation preview is local only, including clicks on normal controls while enabled.
    if ((animationDebug || debugBusy) && ["ARM", "CLASSIFY", "MANUAL_BLOCK", "LOCATION", "AUTO_LOAD"].includes(type)) throw new Error(t("ui_animation_preview_analysis_and_new_blocks_are_disabled_exit_with"));
    const r = await chrome.runtime.sendMessage({ type, ...payload });
    if (!r?.ok) throw new Error(r?.error || t("ui_extension_disconnected_refresh_this_page"));
    return r.data;
  };
  const element = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  // Keep this merge consistent with thread-context.js; page scripts cannot import worker modules.
  function mergeContext(previous, post) {
    if (!previous || previous.id !== post.id || previous.handle !== post.handle) return post;
    const keepText = previous.text && (!post.text || !previous.incomplete && post.incomplete);
    return { ...post, userId: post.userId || previous.userId, conversationId: post.conversationId || previous.conversationId,
      parentId: post.parentId || previous.parentId, text: keepText ? previous.text : post.text,
      incomplete: keepText ? previous.incomplete : post.incomplete, hasMedia: post.hasMedia || previous.hasMedia };
  }
  const sameContext = (a, b) => a && ["handle", "userId", "conversationId", "parentId", "text", "incomplete", "hasMedia", "following", "followingAccount", "followingAt"].every(key => a[key] === b[key]);
  const contextFor = id => {
    const live = metadata.get(id), cached = contextPosts.get(id);
    return live ? mergeContext(cached, live) : cached;
  };
  /** Persist observed text before hiding/analysis. Restored parents never become scan candidates.
   * Each bounded batch is tied to a session; late replies cannot leak into a different task.
   */
  function syncContext(s, account) {
    if (contextFlight) return true;
    if (Date.now() < contextRetryAt) return true;
    if (syncedContextRevision === contextRevision) return false;
    const posts = [], missing = new Set();
    for (const raw of metadata.values()) {
      const p = mergeContext(contextPosts.get(raw.id), raw);
      if (p.conversationId !== s.root.conversationId || white(p)) continue;
      if (!sameContext(savedContext.get(p.id), p) && posts.length < 40) posts.push(p);
      let next = p.parentId;
      const seen = new Set([p.id]);
      for (let depth = 0; next && next !== s.root.id && depth < 30 && !seen.has(next); depth++) {
        seen.add(next);
        const parent = contextFor(next);
        if (!parent || !parent.text || !parent.parentId) {
          if (!requestedContext.has(next) && missing.size < 40) missing.add(next);
          break;
        }
        if (white(parent)) break;
        next = parent.parentId;
      }
    }
    if (!posts.length && !missing.size) { syncedContextRevision = contextRevision; return false; }
    const token = {}; contextFlight = token;
    send("THREAD_CONTEXT", { sessionId: s.id, account, posts, missingIds: [...missing] }).then(result => {
      if (state.session?.id !== s.id || viewer() !== account || route() !== s.root.id) return;
      for (const p of posts) savedContext.set(p.id, p);
      for (const p of result) {
        if (white(p)) continue;
        contextPosts.delete(p.id); contextPosts.set(p.id, p);
        const live = metadata.get(p.id);
        if (live) {
          const merged = mergeContext(p, live);
          metadata.set(p.id, merged);
          // A new observation can arrive while the transaction is pending; only mark the
          // returned version durable so richer/newer live text is saved by the next batch.
          savedContext.set(p.id, p);
        }
      }
      for (const id of missing) requestedContext.add(id);
      while (contextPosts.size > 3000) contextPosts.delete(contextPosts.keys().next().value);
      while (savedContext.size > 3000) savedContext.delete(savedContext.keys().next().value);
      while (requestedContext.size > 3000) requestedContext.delete(requestedContext.values().next().value);
      contextError = ""; contextRetryAt = 0;
    }).catch(() => {
      if (state.session?.id === s.id && viewer() === account) {
        contextError = t("ui_could_not_save_reply_context_retrying"); contextRetryAt = Date.now() + 5000;
      }
    }).finally(() => { if (contextFlight === token) contextFlight = null; schedule(); });
    return true;
  }
  const button = (text, action, className = "") => { const b = element("button", className, text); b.type = "button"; b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); action(e); }); return b; };
  const host = element("div"); host.id = "blocksb-overlay"; host.lang = locale;
  const shadow = host.attachShadow({ mode: "closed" });
  const css = element("link"); css.rel = "stylesheet"; css.href = chrome.runtime.getURL("src/content/overlay.css"); shadow.append(css);
  const trash = button("", () => openDrawer("history"), "trash"); trash.title = t("ui_block_s_b_block_history"); trash.setAttribute("aria-label", trash.title);
  trash.hidden = true;
  // Static SVG only. All page-derived strings use textContent.
  trash.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const badge = element("span", "badge", "0"); trash.append(badge);
  const status = element("div", "session-bar"); status.hidden = true;
  const statusText = element("span");
  const pause = button(t("pause"), async () => { try { await send("TOGGLE_PAUSE"); } catch (e) { toast(e.message); } });
  const stop = button(t("ui_stop"), async () => { try { await send("STOP_SESSION"); } catch (e) { toast(e.message); } });
  const autoLoad = button(t("auto_load_off"), async () => {
    if (autoLoad.disabled) return;
    autoLoad.disabled = true;
    try {
      await send("AUTO_LOAD", { sessionId: state.session.id, account: viewer(), enabled: !state.session.autoLoad });
      loadNote = ""; loadWait = null; autoAt = 0; await refresh();
    } catch (e) { toast(e.message); }
    finally { autoLoad.disabled = false; }
  });
  autoLoad.title = t("ui_automatically_load_more_replies_pauses_when_you_switch_pages_or");
  status.append(statusText, autoLoad, pause, stop);
  const backdrop = button("", closeDrawer, "backdrop"); backdrop.hidden = true; backdrop.setAttribute("aria-label", t("ui_close_panel"));
  const drawer = element("section", "drawer"); drawer.hidden = true; drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-modal", "true"); drawer.setAttribute("aria-label", t("ui_block_s_b_panel"));
  const close = button("×", closeDrawer, "drawer-close"); close.setAttribute("aria-label", t("ui_close_panel"));
  const iframe = element("iframe"); iframe.title = t("ui_block_somebody_panel");
  drawer.append(close, iframe);
  const toastEl = element("div", "toast"); toastEl.hidden = true; toastEl.setAttribute("role", "status");
  const probabilityPanel = element("section", "probability-panel"); probabilityPanel.hidden = true;
  probabilityPanel.setAttribute("role", "tooltip"); probabilityPanel.setAttribute("aria-label", t("ui_probabilities_by_option"));
  const probabilityDetails = new WeakMap();
  let probabilityAnchor = null, probabilityHideTimer, probabilitySignature = "";
  shadow.append(trash, status, backdrop, drawer, toastEl, probabilityPanel); document.body.append(host);
  const debugPanel = element("section", "debug-panel"); debugPanel.hidden = true;
  debugPanel.setAttribute("aria-label", t("ui_debug_panel"));
  const debugHeading = element("div", "debug-heading");
  const debugExit = button(t("ui_debug_exit"), async event => {
    if (!event.isTrusted || debugBusy) return;
    if (state?.settings.debugDryRun && !await setDebugDryRun(false, event)) return;
    resetDebugPreview(); animationDebug = false; debugVisible = false; updateOverlay(); schedule();
  });
  debugHeading.append(element("strong", "", t("ui_debug_panel")), debugExit);
  const debugToggle = (key, change) => {
    const label = element("label", "debug-toggle"), input = element("input"); input.type = "checkbox"; input.setAttribute("role", "switch");
    label.append(element("span", "", t(key)), input);
    input.addEventListener("change", event => { if (event.isTrusted) change(input.checked, event); else renderDebugPanel(); });
    return { label, input };
  };
  const dryToggle = debugToggle("ui_debug_no_block", (value, event) => void setDebugDryRun(value, event));
  const previewToggle = debugToggle("ui_debug_preview_only", value => {
    resetDebugPreview(); animationDebug = value; debugRoute = route(); renderDebugPanel(); schedule();
  });
  const effectLabel = element("label", "debug-toggle", t("ui_animation_style")), debugSelect = element("select");
  for (const [value, key] of [["fly", "ui_fly_to_trash"], ["particles", "ui_particle_dissolve"]]) {
    const option = element("option", "", t(key)); option.value = value; debugSelect.append(option);
  }
  debugSelect.onchange = event => { if (event.isTrusted) debugEffect = debugSelect.value; else renderDebugPanel(); };
  effectLabel.append(debugSelect);
  const debugActions = element("div", "debug-actions");
  const debugPlay = button(t("ui_debug_play"), event => { if (event.isTrusted) playDebugPreview(); });
  const debugReset = button(t("ui_debug_restore"), event => { if (!event.isTrusted) return; resetDebugPreview(); updateOverlay(); schedule(); });
  debugActions.append(debugPlay, debugReset);
  const debugStatus = element("p", "debug-status"); debugStatus.setAttribute("role", "status");
  debugPanel.append(debugHeading, dryToggle.label, previewToggle.label, effectLabel, debugActions, debugStatus, element("p", "debug-hint", t("ui_debug_hint")));
  shadow.append(debugPanel);
  function renderDebugPanel() {
    // A persisted guard stays visible after refresh or in another X tab; hiding it must not
    // silently resume real block jobs. Page messages can only reveal this panel.
    debugPanel.hidden = !debugVisible && !state?.settings.debugDryRun;
    dryToggle.input.checked = !!state?.settings.debugDryRun;
    previewToggle.input.checked = animationDebug;
    debugSelect.value = debugEffect;
    debugExit.disabled = dryToggle.input.disabled = previewToggle.input.disabled = debugBusy;
    debugPlay.disabled = debugReset.disabled = !animationDebug || debugBusy;
    debugStatus.textContent = debugBusy ? t("ui_debug_updating") : state?.settings.debugDryRun ? t("ui_debug_active", simulatedHandles.size) : t("ui_debug_live");
  }
  /** Change the global guard only from a real interaction in our closed-shadow UI. */
  async function setDebugDryRun(enabled, event) {
    if (!event?.isTrusted || debugBusy) return false;
    debugBusy = true; renderDebugPanel();
    try {
      const ack = await send("DEBUG_DRY_RUN", { enabled });
      if (state) state.settings.debugDryRun = ack.enabled;
      skipped.clear(); await refresh(); return true;
    } catch (error) { toast(error.message); return false; }
    finally { debugBusy = false; renderDebugPanel(); schedule(); }
  }
  function resetDebugPreview() {
    debugRows.clear();
    for (const article of movingRows) if (rowState.get(article)?.debug) restore(article);
  }
  function playDebugPreview(postId = "") {
    if (!animationDebug || !route() || debugBusy) return;
    const article = articles().find(article => {
      const p = readPost(article), r = article.getBoundingClientRect();
      return p && p.id !== route() && !white(p) && p.handle !== viewer() && !rowState.has(article)
        && (postId ? p.id === postId : r.bottom > 0 && r.top < innerHeight);
    });
    const post = article && readPost(article);
    if (post) { debugRows.set(post.id, post.handle); updateOverlay(); removeCard(article, post, true, true); }
    else toast(t("ui_block_s_b_no_reply_to_preview_scroll_to_the"));
  }
  const probabilityFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const probabilityPercent = value => `${probabilityFormat.format(value * 100)}%`;
  function hideProbabilityPanel() {
    clearTimeout(probabilityHideTimer);
    probabilityAnchor?.setAttribute("aria-expanded", "false");
    probabilityAnchor = null; probabilitySignature = ""; probabilityPanel.hidden = true;
  }
  function deferProbabilityHide() {
    clearTimeout(probabilityHideTimer);
    probabilityHideTimer = setTimeout(() => {
      if (!probabilityPanel.matches(":hover") && !probabilityAnchor?.matches(":hover,:focus")) hideProbabilityPanel();
    }, 180);
  }
  /** One floating panel outside X's virtual list. Missing legacy scores stay unknown, never invented.
   * Rebuild only when data changes, and discard anchors as soon as X recycles or hides their card.
   */
  function refreshProbabilityPanel() {
    const anchor = probabilityAnchor, detail = anchor && probabilityDetails.get(anchor);
    if (!anchor?.isConnected || !detail || !threadEnabled() || drawerOpen || document.hidden
      || detail.sessionId !== state.session?.id || detail.revision !== state.settings.analysisRevision
      || anchor.closest(".blocksb-masked,.blocksb-exiting,.blocksb-removed")
      || anchor.closest(".blocksb-comment-tools")?.dataset.postId !== detail.postId) { hideProbabilityPanel(); return; }
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= innerHeight || !rect.width) { hideProbabilityPanel(); return; }
    const options = state.settings.ruleOptions || [], decision = detail.decision;
    const signature = JSON.stringify([detail, options, state.settings.high, state.settings.confidence]);
    if (signature !== probabilitySignature) {
      probabilitySignature = signature;
      probabilityPanel.replaceChildren();
      const heading = element("div", "probability-heading");
      heading.append(element("strong", "", t("ui_option_probabilities")), element("span", "", Number.isFinite(decision?.confidence) ? t("ui_confidence", probabilityPercent(decision.confidence)) : t("ui_not_analyzed_yet")));
      probabilityPanel.append(heading);
      const list = element("div", "probability-options");
      const palette = ["#d97706", "#0d9488", "#3982d5", "#9261cb", "#dc5277", "#728b20"];
      let missing = false;
      options.forEach((option, index) => {
        // Before full distributions were stored, only the built-in support score was retained.
        const value = decision?.probabilities?.[option.id] ?? (!decision?.customRule && option.id === "support" ? decision?.support : undefined);
        const known = Number.isFinite(value) && value >= 0 && value <= 1;
        if (!known) missing = true;
        const row = element("div", "probability-option");
        row.style.setProperty("--option-color", palette[index] || `hsl(${Math.round(index * 137.508) % 360} 62% 48%)`);
        const optionName = !state.settings.customRule && ["support", "oppose", "neutral", "uncertain"].includes(option.id) ? t(`category_${option.id}`) : option.name;
        const line = element("div", "probability-option-heading"), name = element("span", "probability-option-name", optionName);
        const tags = element("span", "probability-tags");
        if (option.block) tags.append(element("span", "probability-tag", t("ui_block_target")));
        if (decision?.label === option.id) tags.append(element("span", "probability-tag chosen", t("ui_model_selection")));
        line.append(name, tags, element("strong", "probability-value", known ? probabilityPercent(value) : "—"));
        const bar = element("div", "probability-bar");
        bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-label", optionName);
        bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100");
        if (known) bar.setAttribute("aria-valuenow", String(Math.round(value * 1000) / 10));
        else bar.setAttribute("aria-valuetext", t("ui_no_probability_available"));
        const fill = element("div", "probability-fill"); fill.style.width = `${known ? value * 100 : 0}%`; bar.append(fill);
        if (option.block) {
          const marker = element("span", "probability-threshold"); marker.style.left = `${state.settings.high * 100}%`;
          marker.setAttribute("aria-label", t("ui_block_threshold", probabilityPercent(state.settings.high))); bar.append(marker);
        }
        const scale = element("div", "probability-scale"); scale.append(element("span", "", "0%"), element("span", "", "100%"));
        row.append(line, bar, scale); list.append(row);
      });
      const legend = element("div", "probability-legend");
      legend.append(element("span", "probability-legend-marker"), document.createTextNode(t("ui_block_threshold_confidence_must_be", probabilityPercent(state.settings.high), probabilityPercent(state.settings.confidence))));
      probabilityPanel.append(list, legend);
      if (missing && decision && !decision.error) probabilityPanel.append(element("p", "probability-note", t("ui_older_results_may_lack_a_full_distribution_missing_values_show")));
      probabilityPanel.append(element("p", "probability-note", detail.explanation));
    }
    probabilityPanel.hidden = false;
    const bounds = probabilityPanel.getBoundingClientRect(), margin = 12, gap = 10;
    const left = Math.max(margin, Math.min(rect.left, innerWidth - bounds.width - margin));
    const below = rect.bottom + gap, above = rect.top - bounds.height - gap;
    const top = below + bounds.height <= innerHeight - margin ? below : above >= margin ? above : Math.max(margin, Math.min(below, innerHeight - bounds.height - margin));
    probabilityPanel.style.left = `${left}px`; probabilityPanel.style.top = `${top}px`;
  }
  function showProbabilityPanel(anchor) {
    clearTimeout(probabilityHideTimer);
    if (probabilityAnchor !== anchor) probabilityAnchor?.setAttribute("aria-expanded", "false");
    probabilityAnchor = anchor; anchor.setAttribute("aria-expanded", "true"); refreshProbabilityPanel();
  }
  function probabilityBadge() {
    const badge = element("button", "blocksb-probability"); badge.type = "button"; badge.setAttribute("aria-expanded", "false");
    badge.addEventListener("pointerenter", e => { if (e.pointerType !== "touch") showProbabilityPanel(badge); });
    badge.addEventListener("pointerleave", deferProbabilityHide);
    badge.addEventListener("focus", () => showProbabilityPanel(badge)); badge.addEventListener("blur", deferProbabilityHide);
    badge.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); showProbabilityPanel(badge); });
    return badge;
  }
  probabilityPanel.addEventListener("pointerenter", () => clearTimeout(probabilityHideTimer));
  probabilityPanel.addEventListener("pointerleave", deferProbabilityHide);
  document.addEventListener("keydown", e => { if (e.key === "Escape") hideProbabilityPanel(); }, true);
  document.addEventListener("pointerdown", e => { if (e.target !== probabilityAnchor && !e.composedPath().includes(host)) hideProbabilityPanel(); }, true);
  document.addEventListener("visibilitychange", () => { if (document.hidden) hideProbabilityPanel(); });
  let toastTimer;
  function toast(text) { toastEl.textContent = String(text); toastEl.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 6000); }
  function openDrawer(tab) {
    hideProbabilityPanel();
    // An empty srcdoc injected by another page script takes precedence over src and leaves the drawer blank.
    iframe.removeAttribute("srcdoc");
    iframe.src = chrome.runtime.getURL(`src/manager/manager.html?embedded=1&tab=${tab}&account=${encodeURIComponent(viewer())}`);
    drawerOpen = true; drawer.hidden = backdrop.hidden = false; close.focus();
  }
  function closeDrawer() { drawerOpen = false; drawer.hidden = backdrop.hidden = true; trash.focus(); }
  document.addEventListener("keydown", e => { if (e.key === "Escape" && drawerOpen) { e.stopPropagation(); closeDrawer(); } }, true);
  window.addEventListener("message", e => {
    if (e.source === window && e.origin === location.origin && e.data?.channel === "blocksb:animation-debug:v1") {
      // Console code and site scripts share MAIN world. Neither source/origin nor a
      // trusted MessageEvent authenticates the user. Legacy commands only open UI;
      // do not apply their effect/preview payload or touch any task/backend state.
      if (["enable", "reset", "disable", "play"].includes(e.data.command)) {
        debugVisible = true; renderDebugPanel();
      }
      return;
    }
    if (e.source === iframe.contentWindow && e.origin === new URL(chrome.runtime.getURL("/")).origin && e.data?.type === "blocksb:close") closeDrawer();
    if (e.source === window && e.origin === location.origin && e.data?.channel === "blocksb:timeline:v1") {
      const event = e.data;
      if (!/^\d{5,25}$/.test(event.rootId || "") || typeof event.recent !== "boolean" || !Number.isFinite(event.observedAt)) return;
      const previous = timelineState.get(event.rootId);
      if (!previous || event.observedAt > previous.observedAt) timelineState.set(event.rootId, event);
      while (timelineState.size > 20) timelineState.delete(timelineState.keys().next().value);
      schedule(); return;
    }
    if (e.source !== window || e.origin !== location.origin || e.data?.channel !== "blocksb:metadata:v1" || !Array.isArray(e.data.posts)) return;
    if (followingAccount !== viewer()) { followingUsers.clear(); followingAccount = viewer(); }
    for (const p of e.data.posts.slice(0, 40)) {
      if (!p || !/^\d{5,25}$/.test(p.id) || !/^[a-z0-9_]{1,15}$/.test(p.handle)) continue;
      const previous = metadata.get(p.id);
      const observedAt = Number.isFinite(e.data.observedAt) ? Math.min(Date.now(), e.data.observedAt) : 0;
      const relation = { following: typeof p.following === "boolean" ? p.following : null,
        followingAccount: p.followingAccount === followingAccount ? followingAccount : "",
        followingAt: Number.isFinite(p.followingAt) ? Math.max(0, Math.min(Date.now(), p.followingAt)) : 0 };
      if (relation.followingAccount && typeof relation.following === "boolean" && relation.followingAt) {
        for (const key of [p.userId && `id:${p.userId}`, `handle:${p.handle}`].filter(Boolean)) {
          if ((followingUsers.get(key)?.followingAt || 0) <= relation.followingAt) followingUsers.set(key, { ...relation, userId: p.userId });
        }
        skipped.delete(`${state?.session?.id}:${p.id}`);
      }
      metadata.set(p.id, mergeContext(previous, { id: p.id, handle: p.handle, userId: /^\d{5,25}$/.test(p.userId) ? p.userId : "", name: String(p.name || p.handle).slice(0, 80),
        ...relation,
        text: String(p.text || "").slice(0, 14000), conversationId: String(p.conversationId || ""), parentId: String(p.parentId || ""), hasMedia: !!p.hasMedia, incomplete: !!p.incomplete,
        domSeen: e.data.source === "dom" || !!previous?.domSeen,
        networkAt: e.data.source === "network" ? Math.max(previous?.networkAt || 0, observedAt) : previous?.networkAt || 0 }));
    }
    while (metadata.size > 2500) metadata.delete(metadata.keys().next().value);
    while (followingUsers.size > 5000) followingUsers.delete(followingUsers.keys().next().value);
    contextRevision++;
    schedule();
  });
  window.postMessage({ channel: "blocksb:replay:v1" }, location.origin);

  /** Read the card's own permalink, excluding quotes; merge DOM/network context by ID and author. */
  function readPost(article) {
    const time = article.querySelector('[data-testid="User-Name"] time') || article.querySelector("time");
    const href = time?.closest("a")?.getAttribute("href") || "";
    const match = href.match(/^\/(\w{1,15})\/status\/(\d+)/);
    if (!match) return null;
    const handle = match[1].toLowerCase(), id = match[2];
    const meta = metadata.get(id);
    const text = article.querySelector('[data-testid="tweetText"]')?.innerText || "";
    const p = { id, handle, name: article.querySelector('[data-testid="User-Name"] a')?.textContent || handle, text,
      userId: "", conversationId: "", parentId: "", hasMedia: !!article.querySelector('[data-testid="tweetPhoto"],video,[data-testid="card.wrapper"]'),
      incomplete: !!article.querySelector('[data-testid="tweet-text-show-more-link"]'), url: `https://x.com/${handle}/status/${id}` };
    return meta?.handle === handle ? Object.assign(p, mergeContext(p, mergeContext(contextPosts.get(id), meta))) : p;
  }
  const articles = () => [...document.querySelectorAll('[data-testid="primaryColumn"] article[data-testid="tweet"]')];
  /** Prove descent to the selected post, not merely membership of a larger conversation. */
  function ancestors(reply, root) {
    const chain = [], seen = new Set([reply.id]);
    let next = reply.parentId;
    while (next && next !== root.id && chain.length < 30) {
      if (seen.has(next)) return null;
      seen.add(next);
      const p = contextFor(next);
      if (!p || !p.text.trim() && !p.hasMedia || p.conversationId !== root.conversationId || white(p)) return null;
      chain.push(p); next = p.parentId;
    }
    return next === root.id ? chain : null;
  }
  /** Only the originating task's replies may be hidden. Profiles, other timelines and
   * recommendations are outside scope, even when they contain the same blocked author.
   * A selected nested post also requires a proven parent chain within that branch.
   */
  function taskMayHide(post, history) {
    if (!threadEnabled() || !pageReady || history?.rootId !== state.session.root.id) return false;
    const root = state.session.root;
    if (post.id === root.id || !root.conversationId || post.conversationId !== root.conversationId) return false;
    return root.id === root.conversationId || ancestors(post, root) !== null;
  }
  document.addEventListener("pointerdown", e => {
    const trigger = e.target.closest?.('[data-testid="caret"]');
    if (trigger) { menuTrigger = trigger; menuTarget = readPost(trigger.closest('article[data-testid="tweet"]') || trigger); }
  }, true);
  document.addEventListener("keydown", e => {
    if (["Enter", " "].includes(e.key) && e.target.matches?.('[data-testid="caret"]')) { menuTrigger = e.target; menuTarget = readPost(e.target.closest("article")); }
  }, true);
  /** Dismiss through X's own toggle so its focus trap and backdrop are cleaned up together. */
  function dismissMenu(entry) {
    if (menuTrigger?.isConnected && menuTrigger.getAttribute("aria-expanded") === "true") menuTrigger.click();
    else entry.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true }));
  }
  function injectMenu() {
    const menu = document.querySelector('[role="menu"]');
    if (!menu || !menuTarget || menu.querySelector(".blocksb-menu-item")) return;
    const native = [...menu.querySelectorAll('[role="menuitem"]')].find(n => ["block", "unblock"].includes(n.dataset.testid) || /^(屏蔽\s*@|封鎖\s*@|封锁\s*@|Block\s*@|Unblock\s*@|解除屏蔽|取消屏蔽)/i.test(n.textContent.trim()));
    if (!native) return;
    const target = { ...menuTarget };
    const entry = button(state?.settings.customRule ? t("ui_block_and_apply_reply_rules", target.handle) : t("ui_block_and_agreeing_repliers", target.handle), async e => {
      dismissMenu(e.currentTarget);
      try {
        if (!state?.settings.configured) { openDrawer("settings"); return; }
        const card = menuTrigger?.closest('article[data-testid="tweet"]');
        const link = card?.querySelector('time')?.closest('a');
        await send("ARM", { root: target, account: viewer() });
        await refresh();
        // Let X's router open the existing permalink. Sorting itself always uses X's menu.
        if (route() !== target.id) {
          if (link?.isConnected && link.getAttribute("href")?.match(/\/status\/(\d+)/)?.[1] === target.id) link.click();
          else toast(t("ui_task_created_open_this_post_s_replies_to_switch_automatically"));
        }
        schedule();
      } catch (e) { toast(e.message); }
    }, "blocksb-menu-item");
    entry.setAttribute("role", "menuitem"); native.after(entry);
    const allow = button(t("ui_add_to_allowlist_2", target.handle), async e => {
      dismissMenu(e.currentTarget);
      try { await send("WHITELIST_ADD", target); toast(t("ui_added_to_allowlist_2", target.handle)); } catch (e) { toast(e.message); }
    }, "blocksb-menu-item blocksb-allow-item");
    allow.setAttribute("role", "menuitem"); entry.after(allow);
  }

  function restore(article) {
    clearMask(article);
    const info = rowState.get(article);
    if (!info) return;
    info.cancelled = true;
    for (const animation of info.animations || []) animation.cancel();
    info.releaseAnchor?.();
    info.clone?.remove();
    for (const fragment of info.fragments || []) fragment.remove();
    if (info.opacity && article.style.getPropertyValue("opacity") === "0") {
      if (info.opacity.value) article.style.setProperty("opacity", info.opacity.value, info.opacity.priority);
      else article.style.removeProperty("opacity");
    }
    article.inert = info.inert;
    article.classList.remove("blocksb-folded", "blocksb-removed", "blocksb-exiting");
    for (const [child, original] of info.hiddenChildren || []) {
      if (child.style.getPropertyValue("display") === "none") {
        if (original.value) child.style.setProperty("display", original.value, original.priority);
        else child.style.removeProperty("display");
      }
    }
    article.querySelector(":scope > .blocksb-foldbar")?.remove();
    info.cell?.classList.remove("blocksb-empty-cell");
    rowState.delete(article);
    movingRows.delete(article);
  }
  /** Restore interactivity without changing the original elements' size or display properties. */
  function clearMask(article) {
    const info = maskState.get(article);
    if (!info) return;
    info.cover.remove();
    article.classList.remove("blocksb-masked");
    for (const [child, inert] of info.children) child.inert = inert;
    maskState.delete(article);
  }
  /** Cover the existing card in-place; no folding, height animation or virtual-list offset changes. */
  function maskCard(article, post, decision) {
    const key = `${state.session?.id}:${post.id}`;
    const eligible = threadEnabled() && pageReady && state.settings.maskEnabled && post.id !== route()
      && post.handle !== viewer() && !white(post) && !skipFollowing(post) && !state.session.excluded.includes(post.handle)
      && Number.isFinite(decision?.support) && (decision.customRule ? decision.matched : !["oppose", "neutral"].includes(decision.label))
      && decision.support >= state.settings.maskThreshold && decision.support < state.settings.high
      && !revealedMasks.has(key);
    const previous = maskState.get(article);
    if (previous && (!eligible || previous.key !== key)) clearMask(article);
    if (!eligible) return;
    let info = maskState.get(article);
    if (!info) {
      const cover = element("div", "blocksb-comment-mask");
      cover.setAttribute("role", "group"); cover.setAttribute("aria-label", t("ui_reply_automatically_hidden"));
      cover.append(element("span", "blocksb-mask-label"), button(t("ui_show_reply"), () => {
        revealedMasks.add(key);
        while (revealedMasks.size > 2500) revealedMasks.delete(revealedMasks.values().next().value);
        clearMask(article);
      }, "blocksb-mask-reveal"));
      // Do not let the article's navigation handler receive clicks through the mask.
      cover.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
      info = { key, cover, children: new Map() };
      maskState.set(article, info);
      article.classList.add("blocksb-masked");
      article.append(cover);
    }
    const label = t("ui_auto_hidden", decision.customRule ? t("match_probability") : t("support_probability"), Math.round(decision.support * 100));
    if (info.cover.firstElementChild.textContent !== label) info.cover.firstElementChild.textContent = label;
    // X may replace child nodes while the card remains mounted. Protect new children too.
    for (const child of article.children) if (child !== info.cover && !info.children.has(child)) {
      info.children.set(child, child.inert); child.inert = true;
    }
    if (!info.cover.isConnected) article.append(info.cover);
  }
  /** Add stable, single-line controls beside this card's own date. Missing scores are never zeroes. */
  function commentTools(article, post, decision, history, rootId) {
    let tools = article.querySelector(".blocksb-comment-tools");
    if (!threadEnabled() || !pageReady || !rootId || post.id === rootId) { tools?.remove(); return; }
    const date = (article.querySelector('[data-testid="User-Name"] time') || article.querySelector("time"))?.closest("a");
    if (!date) { tools?.remove(); return; }
    if (tools?.dataset.postId !== post.id) { tools?.remove(); tools = null; }
    if (!tools) {
      tools = element("span", "blocksb-comment-tools"); tools.dataset.postId = post.id;
      tools.append(probabilityBadge(), button(t("ui_block"), async () => {
        const current = readPost(article), account = viewer(), selectedId = route();
        if (!threadEnabled() || !current || current.id !== post.id || !selectedId || !account) { toast(t("ui_task_ended_page_changed_or_account_unavailable_start_again_from")); return; }
        const token = `${account}:${current.handle}`;
        if (manualPending.has(token)) return;
        const root = metadata.get(selectedId) || articles().map(readPost).find(p => p?.id === selectedId) || { id: selectedId, handle: location.pathname.split("/")[1], text: "" };
        manualPending.add(token); schedule();
        try {
          const result = await send("MANUAL_BLOCK", { account, root, reply: current });
          if (["failed", "uncertain", "undo_failed"].includes(result.status)) { toast(t("ui_this_account_needs_review_open_the_trash_to_check_its")); openDrawer("history"); }
          await refresh();
        } catch (e) { toast(e.message); }
        finally { manualPending.delete(token); schedule(); }
      }, "blocksb-block-button"));
      date.after(tools);
    } else if (date.nextElementSibling !== tools) date.after(tools);
    const followingProtected = skipFollowing(post);
    const protectedUser = white(post) || followingProtected, self = post.handle === viewer();
    const scoreName = state.settings.customRule ? t("match_probability") : t("agreement_probability");
    const score = !protectedUser && decision?.error ? t("ui_invalid_analysis_result") : !protectedUser && Number.isFinite(decision?.support) ? `${scoreName} ${Math.round(decision.support * 100)}%` : `${scoreName} —`;
    const badge = tools.firstElementChild, control = tools.lastElementChild;
    if (badge.textContent !== score) badge.textContent = score;
    const s = state.session;
    const categoryName = decision && !decision.customRule && ["support", "oppose", "neutral", "uncertain"].includes(decision.label)
      ? t(`category_${decision.label}`) : decision?.labelName || decision?.label;
    const explanation = white(post) ? t("ui_allowlisted_not_sent_to_jev") : followingProtected ? t(followingStatus(post) === true ? "ui_following_skipped" : "ui_following_unknown") : self ? t("ui_your_own_reply_not_analyzed")
      : decision?.error ? t("ui_reply_kept_no_automatic_retry_in_this_task", String(decision.error))
      : decision ? t("ui_confidence_2", categoryName, Math.round(decision.confidence * 100), decision.blockReasons?.length ? t("ui_not_auto_blocked", decision.blockReasons.join(locale.startsWith("zh") ? "；" : "; ")) : "", history?.status === "failed" ? t("ui_block_submission_failed_check_the_trash") : "")
      : post.handle === s.root.handle ? t("ui_original_author_blocked_by_this_task")
      : s.excluded.includes(post.handle) ? t("ui_excluded_from_this_automatic_task")
      : state.modelError ? t("ui_analysis_needs_attention", String(state.modelError))
      : state.settings.paused || s.paused ? t("ui_analysis_paused")
      : busy.has(`${s.id}:${post.id}`) ? t("ui_analyzing_this_reply")
      : !post.conversationId || !ancestors(post, s.root) ? t("ui_missing_parent_context_in_this_page_and_local_records_load")
      : !post.text.trim() ? t("ui_no_text_to_analyze")
      : t("ui_waiting_to_analyze_this_reply");
    badge.removeAttribute("title");
    badge.setAttribute("aria-label", t("ui_view_probabilities_by_option", score, explanation));
    probabilityDetails.set(badge, { postId: post.id, sessionId: s.id, revision: state.settings.analysisRevision, decision: protectedUser || self ? null : decision, explanation });
    if (probabilityAnchor === badge) refreshProbabilityPanel();
    const pending = manualPending.has(`${viewer()}:${post.handle}`) || ["pending", "running", "undo_pending", "undo_running"].includes(history?.status);
    const label = pending ? t("ui_processing") : t("ui_block");
    if (control.textContent !== label) control.textContent = label;
    control.hidden = followingProtected;
    control.disabled = !!(pending || protectedUser || self || isBlocked(history));
    control.title = protectedUser ? t("ui_this_user_is_allowlisted") : self ? t("ui_you_cannot_block_yourself") : t("ui_block_and_remove_their_other_replies", post.handle);
    control.setAttribute("aria-label", t("ui_block_2", post.handle));
  }
  /** Suspend scroll anchoring only while heights change, restoring the exact previous inline value. */
  function holdScrollAnchor() {
    const style = document.documentElement.style;
    if (!anchorUsers++) {
      anchorStyle = [style.getPropertyValue("overflow-anchor"), style.getPropertyPriority("overflow-anchor")];
      style.setProperty("overflow-anchor", "none", "important");
    }
    let released = false;
    return () => {
      if (released) return; released = true;
      if (!--anchorUsers && style.getPropertyValue("overflow-anchor") === "none") {
        if (anchorStyle[0]) style.setProperty("overflow-anchor", ...anchorStyle);
        else style.removeProperty("overflow-anchor");
      }
    };
  }
  /** Scatter bounded, clipped pieces of the actual card.
   * No canvas readback, screenshots, external assets or image/model service is needed.
   * Returns completion of every fragment; cancellation shares the normal restore path.
   */
  function scatterCard(clone, rect, info) {
    const width = rect.width, height = Math.min(rect.height, 500);
    // Cap DOM cloning for complex media cards. Each compositor layer is only one small tile.
    const columns = clone.querySelectorAll("*").length > 250 ? 8 : 12;
    const rows = Math.max(2, Math.min(6, Math.ceil(height / 28)));
    const layer = document.createDocumentFragment(), completions = [];
    info.fragments = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const tile = element("div", "blocksb-flying-card blocksb-particle");
      tile.inert = true; tile.setAttribute("aria-hidden", "true");
      const left = x * width / columns, top = y * height / rows;
      Object.assign(tile.style, { left: `${rect.left + left}px`, top: `${rect.top + top}px`, width: `${width / columns + .5}px`, height: `${height / rows + .5}px` });
      const piece = clone.cloneNode(true);
      piece.classList.remove("blocksb-flying-card"); piece.classList.add("blocksb-particle-content");
      Object.assign(piece.style, { left: `${-left}px`, top: `${-top}px`, width: `${width}px`, maxHeight: `${height}px` });
      // Cloned media must never start playback inside the fragments.
      piece.querySelectorAll("video,audio").forEach(media => { media.removeAttribute("autoplay"); media.muted = true; });
      tile.append(piece); layer.append(tile); info.fragments.push(tile);
    }
    document.body.append(layer); clone.remove();
    for (let index = 0; index < info.fragments.length; index++) {
      const tile = info.fragments[index], x = index % columns;
      const drift = 35 + Math.random() * 120, lift = -20 - Math.random() * 85, rotation = (Math.random() - .5) * 65;
      const animation = tile.animate([
        { transform: "translate(0,0) scale(1)", opacity: 1, offset: 0 },
        { transform: `translate(${drift * .3}px,${lift * .3}px) rotate(${rotation * .3}deg) scale(.85)`, opacity: .8, offset: .35 },
        { transform: `translate(${drift}px,${lift}px) rotate(${rotation}deg) scale(.05)`, opacity: 0, offset: 1 }
      ], { delay: x * 20 + Math.random() * 70, duration: 650 + Math.random() * 180, easing: "cubic-bezier(.2,.65,.35,1)", fill: "both" });
      info.animations.push(animation); completions.push(animation.finished);
    }
    return Promise.all(completions).finally(() => { for (const fragment of info.fragments) fragment.remove(); });
  }
  /** Play the selected effect while the real row stays blank, then shrink it.
   * X's virtualizer observes the changing height; its cell offsets are never overwritten.
   * The operation is cancellable on undo, failure, account/route change or recycled DOM.
   */
  function removeCard(article, post, animate, debug = false) {
    if (rowState.get(article)?.id === post.id && rowState.get(article).mode === "removed") return;
    restore(article);
    const info = { id: post.id, mode: "removed", handle: post.handle, cancelled: false, debug, inert: article.inert, animations: [] };
    rowState.set(article, info);
    movingRows.add(article);
    const rect = article.getBoundingClientRect(), dest = trash.getBoundingClientRect();
    const key = `${sessionId}:${post.id}`;
    const motion = animate && (debug || !played.has(key)) && !trash.hidden && (debug || state.settings.animation) && !(state?.settings.reducedMotion && matchMedia("(prefers-reduced-motion: reduce)").matches) && rect.bottom > 0 && rect.top < innerHeight && rect.width > 0;
    const valid = () => !info.cancelled && article.isConnected && rowState.get(article) === info && readPost(article)?.id === post.id;
    const finish = () => {
      if (!valid()) return;
      article.classList.add("blocksb-removed");
      article.classList.remove("blocksb-exiting");
      for (const animation of info.animations) animation.cancel();
      info.releaseAnchor?.();
    };
    if (motion) {
      if (!debug) { played.add(key); while (played.size > 5000) played.delete(played.values().next().value); }
      const clone = article.cloneNode(true);
      clone.removeAttribute("id"); clone.querySelectorAll("[id]").forEach(n => n.removeAttribute("id"));
      clone.inert = true; clone.setAttribute("aria-hidden", "true");
      clone.classList.remove("blocksb-folded", "blocksb-removed"); clone.classList.add("blocksb-flying-card");
      Object.assign(clone.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, maxHeight: `${Math.min(rect.height, 500)}px` });
      document.body.append(clone); info.clone = clone;
      // Fade the entire original compositing layer, including media/descendants that
      // X may mark visible. Opacity preserves geometry throughout flight and collapse.
      info.opacity = { value: article.style.getPropertyValue("opacity"), priority: article.style.getPropertyPriority("opacity") };
      article.style.setProperty("opacity", "0", "important");
      article.classList.add("blocksb-exiting"); article.inert = true;
      let effectFinished;
      const effect = debug || debugVisible && state.settings.debugDryRun ? debugEffect : state.settings.animationEffect;
      if (effect === "particles") effectFinished = scatterCard(clone, rect, info);
      else {
        const flight = clone.animate([{ transform: "translate(0,0) scale(1)", opacity: .95 }, { transform: `translate(${dest.left + dest.width / 2 - rect.left - rect.width / 2}px,${dest.top + dest.height / 2 - rect.top - Math.min(rect.height, 500) / 2}px) scale(.04) rotate(8deg)`, opacity: 0 }], { duration: 700, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" });
        info.animations.push(flight); effectFinished = flight.finished;
      }
      const bounce = trash.animate([{ transform: "scale(1)" }, { transform: "scale(1.14) rotate(-5deg)" }, { transform: "scale(1)" }], { delay: 540, duration: 260 });
      info.animations.push(bounce);
      void (async () => {
        try {
          await effectFinished; clone.remove();
          if (info.cancelled) return;
          if (!valid()) { restore(article); return; }
          info.releaseAnchor = holdScrollAnchor();
          const style = getComputedStyle(article);
          const from = { height: `${article.getBoundingClientRect().height}px`, minHeight: "0px", maxHeight: "none" };
          const to = { height: "0px", minHeight: "0px", maxHeight: "none" };
          for (const property of ["paddingTop", "paddingBottom", "marginTop", "marginBottom", "borderTopWidth", "borderBottomWidth"]) { from[property] = style[property]; to[property] = "0px"; }
          const collapse = article.animate([from, to], { duration: 360, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" });
          info.animations.push(collapse);
          await collapse.finished;
          if (info.cancelled) return;
          if (valid()) finish(); else restore(article);
        } catch { if (!info.cancelled) { clone.remove(); finish(); } }
      })();
      return;
    }
    finish();
  }
  function updateOverlay() {
    renderDebugPanel();
    trash.hidden = !featureEnabled() && !(animationDebug && debugRows.size);
    alignTrash();
    const s = state?.session;
    const count = state?.history.filter(h => ["blocked", "submitted"].includes(h.status)).length || 0;
    badge.textContent = count > 99 ? "99+" : String(count); badge.hidden = !count;
    status.hidden = !featureEnabled();
    if (!status.hidden) {
      const paused = state.settings.paused || s.paused;
      statusText.textContent = state.modelError || state.queueError || state.queueNotice ? t("ui_needs_attention_open_trash") : paused ? t("ui_paused")
        : !threadEnabled() ? t("ui_left_thread_queued_blocks_continue_in_background")
        : contextError ? contextError
        : !pageReady ? loadNote || t("ui_waiting_for_the_first_page_of_recent_replies")
        : !s.active ? locationError || t("ui_replies_ready_syncing_task_status")
        : loadNote || t("ui_checked", s.count, Object.values(s.results).some(r => r.error) ? t("ui_invalid_results", Object.values(s.results).filter(r => r.error).length) : "", s.autoLoad ? t("ui_auto_loading") : "", failure ? t("ui_some_replies_lack_context") : "");
      pause.textContent = state.settings.paused ? t("resume") : t("pause");
      autoLoad.textContent = s.autoLoad ? t("auto_load_on") : t("auto_load_off");
      autoLoad.setAttribute("aria-pressed", String(!!s.autoLoad));
      autoLoad.hidden = !threadEnabled();
    }
    const bg = getComputedStyle(document.body).backgroundColor;
    const rgb = bg.match(/\d+/g)?.map(Number);
    host.dataset.dark = rgb && rgb.slice(0, 3).reduce((a, b) => a + b, 0) < 330 ? "true" : "false";
  }
  /** Follow X's own dock geometry, including browser zoom and responsive layout. */
  function alignTrash() {
    if (trash.hidden) return;
    const candidates = [...document.querySelectorAll('button[aria-label="Grok"],[role="button"][aria-label="Grok"]')];
    const grok = candidates.map(e => ({ e, r: e.getBoundingClientRect() })).find(({ r }) => r.width > 25 && r.width < 100 && r.left > innerWidth * .65 && r.top > innerHeight * .4);
    if (!grok) return;
    const chat = [...document.querySelectorAll('button[aria-label="聊天"],button[aria-label="Chat"],button[aria-label="チャット"],button[aria-label="채팅"],[role="button"][aria-label="聊天"],[role="button"][aria-label="Chat"],[role="button"][aria-label="チャット"],[role="button"][aria-label="채팅"]')]
      .map(e => e.getBoundingClientRect()).find(r => r.top > grok.r.bottom && Math.abs(r.left - grok.r.left) < 10);
    const gap = chat ? Math.max(6, Math.min(28, chat.top - grok.r.bottom)) : 12;
    const rect = grok.r, top = rect.top - rect.height - gap;
    Object.assign(trash.style, { left: `${rect.left}px`, right: "auto", top: `${top}px`, bottom: "auto", width: `${rect.width}px`, height: `${rect.height}px`, borderRadius: getComputedStyle(grok.e).borderRadius });
    Object.assign(status.style, { right: `${innerWidth - rect.left + 12}px`, bottom: `${innerHeight - top - rect.height / 2 - 21}px` });
  }
  async function refresh() {
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      const previousState = state;
      state = await send("SNAPSHOT", { account: viewer() });
      indexSnapshot();
      if (previousState && JSON.stringify(previousState.whitelist) !== JSON.stringify(state.whitelist)) {
        syncedContextRevision = -1; requestedContext.clear();
        for (const [id, p] of contextPosts) if (white(p)) { contextPosts.delete(id); savedContext.delete(id); }
      }
      if (previousState && (previousState.modelError && !state.modelError || previousState.settings.paused && !state.settings.paused || previousState.settings.analysisRevision !== state.settings.analysisRevision || previousState.settings.skipFollowing !== state.settings.skipFollowing)) skipped.clear();
      if (sessionId !== (state.session?.id || "")) {
        contextPosts.clear(); savedContext.clear(); requestedContext.clear(); contextFlight = null; contextRetryAt = 0; contextError = ""; syncedContextRevision = -1;
        sessionId = state.session?.id || ""; skipped.clear(); failure = ""; lastLocation = ""; locationRetryAt = 0; locationError = "";
        pageReady = false; sortFlow = null; loadWait = null; loadNote = ""; autoAt = 0;
        // Starting a task must discover existing cards without waiting for a scroll or request.
        if (sessionId) window.postMessage({ channel: "blocksb:replay:v1" }, location.origin);
      }
      updateOverlay(); schedule();
    } catch (e) { statusText.textContent = String(e.message); }
    finally { refreshing = false; if (refreshAgain) { refreshAgain = false; void refresh(); } }
  }
  function schedule() { if (!timer) timer = setTimeout(() => { timer = null; scan(); }, 160); }
  /** Drive X's native sort menu without changing location or reloading the document.
   * A selected label is not readiness: wait for a matching response or settled replacement rows.
   */
  function prepareThread(rows) {
    if (!threadEnabled()) { pageReady = false; sortFlow = null; loadWait = null; loadNote = ""; return; }
    const now = Date.now(), root = state.session.root;
    if (!sortFlow) sortFlow = { started: now, clicked: 0, attempted: false, opened: false, confirmed: false, signature: "", stableSince: now, before: "", scrolled: false };
    const flow = sortFlow;
    const visible = node => node?.isConnected && node.getBoundingClientRect().height > 0;
    const recentLabel = /^(最近|最新|最新順|新しい順|최신|최신순|Most recent|Recent|Latest)$/i;
    const sortLabel = /^(相关|相關|最近|最新|喜欢|喜歡|関連性の高い順|関連性|最新順|新しい順|いいね|いいねの多い順|관련성|관련성 높은 순|최신|최신순|마음에 들어요|Relevant|Most relevant|Most recent|Recent|Latest|Likes|Most liked)$/i;
    const focal = rows.find(a => readPost(a)?.id === root.id);
    const control = focal && [...focal.querySelectorAll('button,[role="button"]')].find(b => visible(b) && sortLabel.test(b.textContent.trim()));
    const recent = control && recentLabel.test(control.textContent.trim());
    const signature = rows.map(readPost).filter(p => p && p.id !== root.id && p.conversationId === root.conversationId).map(p => p.id).join(",");
    if (signature !== flow.signature) { flow.signature = signature; flow.stableSince = now; }
    const event = timelineState.get(route());
    const fresh = event && (!flow.clicked || event.firstStartedAt >= flow.clicked);
    if (recent || !control && event?.recent && fresh) flow.confirmed = true;
    if (control && !recent || fresh && event && !event.recent && !recent) {
      if (flow.confirmed) { flow.attempted = false; flow.opened = false; flow.started = now; }
      flow.confirmed = false; pageReady = false;
    }
    if (!flow.confirmed) {
      pageReady = false; loadNote = lastSortNote = t("ui_switching_to_most_recent_using_the_page_menu");
      if (document.hidden || drawerOpen || state.settings.paused || state.session.paused) return;
      const menu = document.querySelector('[role="menu"]');
      if (flow.opened && menu) {
        const option = [...menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')].find(b => visible(b) && recentLabel.test(b.textContent.trim()));
        if (option && !flow.attempted) {
          flow.clicked = now; flow.before = signature; flow.attempted = true;
          option.click(); return;
        }
      } else if (control && !menu && !flow.opened && !flow.attempted) {
        flow.opened = true; control.click(); return;
      }
      if (!control && !flow.scrolled && scrollY > 0 && now - flow.started > 1500) {
        flow.scrolled = true; window.scrollTo({ top: 0, behavior: "instant" });
      }
      if (now - flow.started > 12000) loadNote = lastSortNote = t("ui_could_not_switch_automatically_choose_most_recent_on_x_to");
      return;
    }
    // Errors and stale first-page signals never authorize work, including after a manual sort change.
    if (fresh && event?.recent && !event.ok) { pageReady = false; loadNote = lastSortNote = t("ui_replies_failed_to_load_retry_on_x", event.status ? ` (HTTP ${event.status})` : ""); return; }
    const loading = !!document.querySelector('[data-testid="primaryColumn"] [role="progressbar"]');
    const settledDOM = recent && signature && !loading && now - flow.stableSince >= 800 && (!flow.clicked || signature !== flow.before);
    if (fresh && event?.recent && event.firstReady || settledDOM) {
      pageReady = true;
      // Readiness is state, not a prefix in a translated status message.
      if (loadNote === lastSortNote) loadNote = "";
    } else if (!pageReady) loadNote = lastSortNote = now - flow.started > 25000 ? t("ui_waiting_for_recent_replies_check_if_x_needs_a_retry") : t("ui_waiting_for_the_first_page_of_recent_replies");
  }
  /** Stop only scrolling; analysis and already-approved background block jobs retain their state. */
  async function stopAuto(note) {
    if (autoStopping) return;
    autoStopping = true; loadNote = note; loadWait = null;
    const s = state.session;
    try {
      await send("AUTO_LOAD", { sessionId: s.id, account: viewer(), enabled: false });
      if (state.session?.id === s.id) state.session.autoLoad = false;
    } catch (e) { toast(e.message); }
    finally { autoStopping = false; updateOverlay(); }
  }
  /** Scroll the native list in bounded steps, with analysis backpressure and a no-progress stop.
   * No synthetic X pagination requests, hidden-tab scrolling or automatic retries of errors.
   */
  function advanceComments(active) {
    const s = state?.session;
    if (!active || !pageReady || !s?.autoLoad || drawerOpen || document.hidden || autoStopping) { loadWait = null; return; }
    const event = timelineState.get(route());
    if (state.modelError || state.queueError || state.queueNotice || event && !event.ok) {
      void stopAuto(t("ui_auto_load_stopped_due_to_a_service_or_loading_error")); return;
    }
    if (s.count >= 2000) { void stopAuto(t("ui_auto_load_stopped_this_task_reached_the_2_000_reply")); return; }
    // Drain already discovered, eligible replies before moving the viewport and triggering more pages.
    const account = viewer();
    const pending = busy.size || [...metadata.values()].some(p => {
      const token = `${s.id}:${p.id}`;
      if (!p.domSeen && !(p.networkAt > 0 && p.networkAt >= s.created)) return false;
      if (hasDecision(p) || skipped.has(token) || p.id === s.root.id || p.handle === account || p.handle === s.root.handle || white(p) || skipFollowing(p) || s.excluded.includes(p.handle) || isBlocked(historyFor(p, account)) || !p.text.trim()) return false;
      return p.conversationId === s.root.conversationId && ancestors(p, s.root) !== null;
    });
    if (pending) { loadWait = null; return; }
    const now = Date.now();
    if (now - autoAt < 2500) return;
    autoAt = now;
    if (loadWait && (loadWait.size !== metadata.size || (event?.observedAt || 0) > loadWait.responseAt)) loadWait = null;
    const atBottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 100;
    if (!atBottom) { loadWait = null; window.scrollBy({ top: Math.max(240, innerHeight * .8), behavior: "instant" }); return; }
    const spam = [...document.querySelectorAll('[data-testid="primaryColumn"] button,[data-testid="primaryColumn"] [role="button"]')]
      .find(b => /^(显示可能的垃圾信息|显示可能的垃圾消息|顯示可能的垃圾訊息|顯示可能的垃圾回覆|スパムの可能性がある返信を表示|スパムと思われる返信を表示|스팸일 수 있는 답글 보기|Show probable spam)$/i.test(b.textContent.trim()) && b.getBoundingClientRect().height > 0 && !openedSpam.has(b));
    if (spam) { openedSpam.add(spam); spam.click(); loadWait = null; return; }
    if (event?.ok && event.ended) { void stopAuto(t("ui_end_of_x_s_results_queued_blocks_will_continue")); return; }
    if (!loadWait) loadWait = { since: now, size: metadata.size, responseAt: event?.observedAt || 0 };
    else if (now - loadWait.since > 30000) { void stopAuto(t("ui_no_new_replies_for_30_seconds_auto_load_stopped_check")); return; }
    window.scrollBy({ top: Math.max(240, innerHeight * .8), behavior: "instant" });
  }
  function scan() {
    if (probabilityAnchor) refreshProbabilityPanel();
    injectMenu();
    if (debugRoute !== route()) { debugRows.clear(); debugRoute = route(); }
    for (const article of movingRows) {
      const info = rowState.get(article), post = readPost(article);
      if (!article.isConnected || post?.id !== info.id || info.debug && (!animationDebug || !debugRows.has(info.id))) restore(article);
    }
    // Also clean recycled/hidden rows when the task ends or the user leaves its thread.
    if (!threadEnabled() || state?.account !== viewer()) {
      document.querySelectorAll(".blocksb-comment-tools").forEach(node => node.remove());
      document.querySelectorAll(".blocksb-masked,.blocksb-removed,.blocksb-exiting").forEach(article => {
        if (!(animationDebug && debugRows.has(readPost(article)?.id))) restore(article);
      });
    }
    updateOverlay();
    if (!state) return;
    // Preview does not activate a task or send any model/account requests.
    if (animationDebug || debugBusy) return;
    const s = state.session, account = viewer(), rootId = route();
    const rows = articles();
    prepareThread(rows);
    if (state.account !== account) { void refresh(); return; }
    const candidateRoot = rows.map(readPost).find(p => p?.id === s?.root.id) || metadata.get(s?.root.id);
    const focal = candidateRoot?.handle === s?.root.handle ? candidateRoot : null;
    // Save even replies by already-blocked authors: another comment may refer to them later.
    if (threadEnabled() && s.root.conversationId && syncContext(s, account)) { updateOverlay(); return; }
    const locationKey = `${location.href}|${account}|${sessionId}|${focal?.conversationId || ""}|${state.settings.paused}|${pageReady}`;
    if (s && locationKey !== lastLocation && !locationSending && Date.now() >= locationRetryAt) {
      locationSending = true;
      const ready = pageReady, onThread = account === s.account && rootId === s.root.id;
      if (rootId === s.root.id) window.postMessage({ channel: "blocksb:replay:v1" }, location.origin);
      send("LOCATION", { account, postId: rootId, root: focal, pageReady, sort: pageReady ? "recent" : "unknown", sessionId: s.id })
        .then(ack => {
          if (state.session?.id !== s.id || route() !== rootId || viewer() !== account) return;
          // A sent message is not an activation acknowledgement. Retry a transient route mismatch,
          // and serialize notifications so an older not-ready update cannot overtake a ready one.
          if (ack?.sessionId === s.id && ack.onThread === onThread && ack.pageReady === (onThread && ready)
            && ack.active === (!s.stopped && onThread && (!s.sortRequired || ready))) {
            lastLocation = locationKey; locationRetryAt = 0; locationError = "";
            Object.assign(state.session, ack);
          } else { lastLocation = ""; locationRetryAt = Date.now() + 1500; }
          return refresh();
        }).catch(e => {
          if (state.session?.id === s.id) { lastLocation = ""; locationRetryAt = Date.now() + 2500; locationError = t("ui_could_not_sync_task_status", String(e.message)); }
        }).finally(() => { locationSending = false; schedule(); });
    }
    const active = pageReady && s && !s.stopped && !s.paused && !state.settings.paused && s.active && s.account === account && rootId === s.root.id;
    for (const article of rows) {
      const p = readPost(article);
      if (!p) { restore(article); article.querySelector(".blocksb-comment-tools")?.remove(); continue; }
      const old = rowState.get(article);
      const decision = s?.root.id === rootId ? s.results[p.id] : null;
      // The classification response already confirms durable enqueue, before the X request completes.
      const h = historyFor(p, account) || (decision?.historyId ? { id: decision.historyId, rootId, status: "pending", updated: Date.now() } : null);
      const queued = ["pending", "running"].includes(h?.status) && !h?.waitingFollowing;
      const hide = taskMayHide(p, h) && (isBlocked(h) || queued) && !white(p) && (p.handle === s.root.handle || !skipFollowing(p)) && p.handle !== account;
      if (old && !hide && ["failed", "uncertain"].includes(h?.status) && !reportedFailures.has(h.id)) {
        reportedFailures.add(h.id); toast(t("ui_block_for_did_not_complete_replies_restored_check_the_trash", p.handle));
      }
      if (old && (old.id !== p.id || !hide || old.mode !== "removed")) restore(article);
      if (hide) { removeCard(article, p, queued || ["blocked", "submitted"].includes(h.status) && Date.now() - h.updated < 6000); continue; }
      commentTools(article, p, decision, h, rootId);
      maskCard(article, p, decision);
    }
    // Existing candidates come from DOM scans. New responses may add candidates after activation;
    // replayed old network data supplies context only. Both paths share deduplication and ancestry checks.
    failure = "";
    if (active && !state.modelError && state.settings.configured) for (const raw of metadata.values()) {
      const p = mergeContext(contextPosts.get(raw.id), raw);
      if (busy.size >= 2) break;
      if (!p.domSeen && !(p.networkAt > 0 && p.networkAt >= s.created)) continue;
      if (hasDecision(p) || busy.has(`${s.id}:${p.id}`) || p.id === s.root.id || p.handle === account || p.handle === s.root.handle || white(p) || skipFollowing(p) || s.excluded.includes(p.handle) || isBlocked(historyFor(p, account))) continue;
      if (!p.conversationId || p.conversationId !== s.root.conversationId) continue;
      const chain = ancestors(p, s.root);
      if (!chain) { failure = "context"; continue; }
      const token = `${s.id}:${p.id}`; busy.add(token);
      const fingerprint = `${p.text}|${p.parentId}|${chain[0]?.text || ""}`;
      if (skipped.get(token) === fingerprint) { busy.delete(token); continue; }
      const analysisRevision = state.settings.analysisRevision;
      send("CLASSIFY", { sessionId: s.id, account, reply: p, parent: chain[0] || null, ancestors: chain }).then(result => {
        if (state.settings.analysisRevision !== analysisRevision) return;
        if (state.session?.id === s.id && result.action !== "skip") { state.session.results[p.id] = result; indexSnapshot(); }
        schedule();
        if (result.action === "skip" && result.why !== "config-changed") skipped.set(token, fingerprint);
      }).catch(e => {
        if (state.settings.analysisRevision !== analysisRevision) return;
        // A storage/validation failure must not resubmit the same comment and consume more credit.
        // Explicit service recovery or pause/resume clears this local latch.
        skipped.set(token, fingerprint);
        if (!state.modelError && state.session?.id === s.id) toast(e.message);
      }).finally(() => { busy.delete(token); clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); });
    }
    advanceComments(active); updateOverlay();
  }
  const observer = new MutationObserver(records => {
    if (records.some(r => {
      const node = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      const owned = "#blocksb-overlay,.blocksb-comment-tools,.blocksb-comment-mask,.blocksb-flying-card,.blocksb-menu-item";
      if (node?.closest?.(owned)) return false;
      const changed = [...r.addedNodes, ...r.removedNodes];
      return !changed.length || !changed.every(n => n.nodeType === 1 && n.matches(owned));
    })) schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("scroll", e => { if (e.target !== host && !host.contains(e.target)) hideProbabilityPanel(); schedule(); }, { passive: true, capture: true });
  window.addEventListener("resize", () => { hideProbabilityPanel(); schedule(); }, { passive: true });
  let previous = "";
  // Restore rows immediately on route/account changes, even while a background snapshot is pending.
  setInterval(() => { alignTrash(); const key = `${location.href}|${viewer()}`; if (key !== previous) { previous = key; schedule(); void refresh(); } else if (featureEnabled()) schedule(); }, 900);
  chrome.runtime.onMessage.addListener(message => { if (message?.type === "STATE_CHANGED") { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 100); } });
  void refresh();
})();
