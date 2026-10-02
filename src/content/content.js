(() => {
  const metadata = new Map(), busy = new Set(), skipped = new Map(), rowState = new WeakMap(), manualPending = new Set();
  const maskState = new WeakMap(), revealedMasks = new Set();
  const timelineState = new Map();
  const whiteHandles = new Set(), whiteIds = new Set(), historyHandles = new Map(), historyIds = new Map();
  const movingRows = new Set(), played = new Set(), reportedFailures = new Set(), debugRows = new Map();
  let animationDebug = false, debugEffect = "fly", debugRoute = "", anchorUsers = 0, anchorStyle;
  let pageReady = false, sortFlow = null, loadNote = "", autoAt = 0, loadWait = null, autoStopping = false;
  const openedSpam = new WeakSet();
  let state = null, menuTarget = null, menuTrigger = null, timer, refreshTimer, refreshing = false, refreshAgain = false, lastLocation = "", sessionId = "", failure = "", drawerOpen = false;
  let locationSending = false, locationRetryAt = 0, locationError = "";
  const route = () => location.pathname.match(/^\/\w+\/status\/(\d+)/)?.[1] || "";
  const viewer = () => globalThis.BlockSBX.viewer();
  // A saved, unfinished task proves explicit activation in this tab; pause retains its controls.
  const featureEnabled = () => !!(state?.session && !state.session.stopped && state.session.account === viewer());
  const threadEnabled = () => featureEnabled() && route() === state.session.root.id;
  const white = p => whiteHandles.has(p.handle) || !!(p.userId && whiteIds.has(p.userId));
  const hasDecision = p => {
    const result = state?.session?.results[p.id];
    return result && (result.error || !state.decisionVersion || result.decisionVersion === state.decisionVersion);
  };
  // Read the latest account relationship (including undo), but scope DOM hiding separately to its task.
  const historyFor = (p, account = viewer()) => {
    if (!state || state.account !== account) return null;
    const handle = historyHandles.get(p.handle), id = p.userId && historyIds.get(p.userId);
    return (id && (!handle || id.order > handle.order) ? id : handle)?.entry;
  };
  /** Rebuild once per snapshot, not once per comment. Preserve findLast ordering even after renames. */
  function indexSnapshot() {
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
    // Console preview is local only, including clicks on the normal controls while it is enabled.
    if (animationDebug && ["ARM", "CLASSIFY", "MANUAL_BLOCK", "LOCATION", "AUTO_LOAD"].includes(type)) throw new Error("动画调试中：不分析、不创建屏蔽任务。使用 blockSBDebug.disable() 退出。");
    const r = await chrome.runtime.sendMessage({ type, ...payload });
    if (!r?.ok) throw new Error(r?.error || "扩展连接已断开，请刷新页面。");
    return r.data;
  };
  const element = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const button = (text, action, className = "") => { const b = element("button", className, text); b.type = "button"; b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); action(e); }); return b; };
  const host = element("div"); host.id = "blocksb-overlay";
  const shadow = host.attachShadow({ mode: "closed" });
  const css = element("link"); css.rel = "stylesheet"; css.href = chrome.runtime.getURL("src/content/overlay.css"); shadow.append(css);
  const trash = button("", () => openDrawer("history"), "trash"); trash.title = "block s.b. · 屏蔽记录"; trash.setAttribute("aria-label", trash.title);
  trash.hidden = true;
  // Static SVG only. All page-derived strings use textContent.
  trash.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const badge = element("span", "badge", "0"); trash.append(badge);
  const status = element("div", "session-bar"); status.hidden = true;
  const statusText = element("span");
  const pause = button("暂停", async () => { try { await send("TOGGLE_PAUSE"); } catch (e) { toast(e.message); } });
  const stop = button("结束", async () => { try { await send("STOP_SESSION"); } catch (e) { toast(e.message); } });
  const autoLoad = button("自动加载：关", async () => {
    if (autoLoad.disabled) return;
    autoLoad.disabled = true;
    try {
      await send("AUTO_LOAD", { sessionId: state.session.id, account: viewer(), enabled: !state.session.autoLoad });
      loadNote = ""; loadWait = null; autoAt = 0; await refresh();
    } catch (e) { toast(e.message); }
    finally { autoLoad.disabled = false; }
  });
  autoLoad.title = "开启后自动向下加载评论；切到其他页面或标签页时暂停翻页";
  status.append(statusText, autoLoad, pause, stop);
  const backdrop = button("", closeDrawer, "backdrop"); backdrop.hidden = true; backdrop.setAttribute("aria-label", "关闭管理面板");
  const drawer = element("section", "drawer"); drawer.hidden = true; drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-modal", "true"); drawer.setAttribute("aria-label", "block s.b. 管理面板");
  const close = button("×", closeDrawer, "drawer-close"); close.setAttribute("aria-label", "关闭管理面板");
  const iframe = element("iframe"); iframe.title = "block somebody 管理面板";
  drawer.append(close, iframe);
  const toastEl = element("div", "toast"); toastEl.hidden = true; toastEl.setAttribute("role", "status");
  shadow.append(trash, status, backdrop, drawer, toastEl); document.body.append(host);
  let toastTimer;
  function toast(text) { toastEl.textContent = text; toastEl.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 6000); }
  function openDrawer(tab) {
    // An empty srcdoc injected by another page script takes precedence over src and leaves the drawer blank.
    iframe.removeAttribute("srcdoc");
    iframe.src = chrome.runtime.getURL(`src/manager/manager.html?embedded=1&tab=${tab}&account=${encodeURIComponent(viewer())}`);
    drawerOpen = true; drawer.hidden = backdrop.hidden = false; close.focus();
  }
  function closeDrawer() { drawerOpen = false; drawer.hidden = backdrop.hidden = true; trash.focus(); }
  document.addEventListener("keydown", e => { if (e.key === "Escape" && drawerOpen) { e.stopPropagation(); closeDrawer(); } }, true);
  window.addEventListener("message", e => {
    if (e.source === window && e.origin === location.origin && e.data?.channel === "blocksb:animation-debug:v1") {
      const { command, postId } = e.data;
      if (command === "enable") { animationDebug = true; debugEffect = e.data.effect === "particles" ? "particles" : "fly"; debugRoute = route(); }
      else if (command === "reset" || command === "disable") {
        debugRows.clear();
        for (const article of movingRows) if (rowState.get(article)?.debug) restore(article);
        if (command === "disable") animationDebug = false;
      } else if (command === "play" && animationDebug && route()) {
        const candidates = articles().filter(article => {
          const p = readPost(article), r = article.getBoundingClientRect();
          return p && p.id !== route() && !white(p) && p.handle !== viewer() && !rowState.has(article)
            && (postId ? p.id === postId : r.bottom > 0 && r.top < innerHeight);
        });
        const article = candidates[0], post = article && readPost(article);
        if (post) { debugRows.set(post.id, post.handle); updateOverlay(); removeCard(article, post, true, true); }
        else console.info("[block s.b.] 找不到可预览的评论，请滚动到评论区或提供可见评论的帖子 ID。");
      }
      updateOverlay(); schedule(); return;
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
    for (const p of e.data.posts.slice(0, 40)) {
      if (!p || !/^\d{5,25}$/.test(p.id) || !/^[a-z0-9_]{1,15}$/.test(p.handle)) continue;
      const previous = metadata.get(p.id);
      const observedAt = Number.isFinite(e.data.observedAt) ? Math.min(Date.now(), e.data.observedAt) : 0;
      metadata.set(p.id, { id: p.id, handle: p.handle, userId: /^\d{5,25}$/.test(p.userId) ? p.userId : "", name: String(p.name || p.handle).slice(0, 80),
        text: String(p.text || "").slice(0, 14000), conversationId: String(p.conversationId || ""), parentId: String(p.parentId || ""), hasMedia: !!p.hasMedia, incomplete: !!p.incomplete,
        domSeen: e.data.source === "dom" || !!previous?.domSeen,
        networkAt: e.data.source === "network" ? Math.max(previous?.networkAt || 0, observedAt) : previous?.networkAt || 0 });
    }
    while (metadata.size > 2500) metadata.delete(metadata.keys().next().value);
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
    if (meta?.handle === handle) Object.assign(p, meta);
    return p;
  }
  const articles = () => [...document.querySelectorAll('[data-testid="primaryColumn"] article[data-testid="tweet"]')];
  /** Prove descent to the selected post, not merely membership of a larger conversation. */
  function ancestors(reply, root) {
    const chain = [], seen = new Set([reply.id]);
    let next = reply.parentId;
    while (next && next !== root.id && chain.length < 30) {
      if (seen.has(next)) return null;
      seen.add(next);
      const p = metadata.get(next);
      if (!p || p.conversationId !== root.conversationId || white(p)) return null;
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
    const entry = button(`屏蔽 @${target.handle} 及其评论区的支持者`, async e => {
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
          else toast("任务已建立，请打开这条帖子的评论区，插件会自动选择最近排序。");
        }
        schedule();
      } catch (e) { toast(e.message); }
    }, "blocksb-menu-item");
    entry.setAttribute("role", "menuitem"); native.after(entry);
    const allow = button(`将 @${target.handle} 加入白名单`, async e => {
      dismissMenu(e.currentTarget);
      try { await send("WHITELIST_ADD", target); toast(`@${target.handle} 已加入白名单。`); } catch (e) { toast(e.message); }
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
      && post.handle !== viewer() && !white(post) && !state.session.excluded.includes(post.handle)
      && Number.isFinite(decision?.support) && !["oppose", "neutral"].includes(decision.label)
      && decision.support >= state.settings.maskThreshold && decision.support < state.settings.high
      && !revealedMasks.has(key);
    const previous = maskState.get(article);
    if (previous && (!eligible || previous.key !== key)) clearMask(article);
    if (!eligible) return;
    let info = maskState.get(article);
    if (!info) {
      const cover = element("div", "blocksb-comment-mask");
      cover.setAttribute("role", "group"); cover.setAttribute("aria-label", "评论已自动隐藏");
      cover.append(element("span", "blocksb-mask-label"), button("查看原文", () => {
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
    const label = `已自动隐藏 · 支持概率 ${Math.round(decision.support * 100)}%`;
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
      tools.append(element("span", "blocksb-probability"), button("加入屏蔽", async () => {
        const current = readPost(article), account = viewer(), selectedId = route();
        if (!threadEnabled() || !current || current.id !== post.id || !selectedId || !account) { toast("任务已结束、页面已切换或无法确认登录账号，请重新从帖子菜单启动。"); return; }
        const token = `${account}:${current.handle}`;
        if (manualPending.has(token)) return;
        const root = metadata.get(selectedId) || articles().map(readPost).find(p => p?.id === selectedId) || { id: selectedId, handle: location.pathname.split("/")[1], text: "" };
        manualPending.add(token); schedule();
        try {
          const result = await send("MANUAL_BLOCK", { account, root, reply: current });
          if (["failed", "uncertain", "undo_failed"].includes(result.status)) { toast("该账号的操作需要核对，请在垃圾桶中处理。"); openDrawer("history"); }
          await refresh();
        } catch (e) { toast(e.message); }
        finally { manualPending.delete(token); schedule(); }
      }, "blocksb-block-button"));
      date.after(tools);
    } else if (date.nextElementSibling !== tools) date.after(tools);
    const protectedUser = white(post), self = post.handle === viewer();
    const score = !protectedUser && decision?.error ? "分析结果异常" : !protectedUser && Number.isFinite(decision?.support) ? `附和概率 ${Math.round(decision.support * 100)}%` : "附和概率 —";
    const badge = tools.firstElementChild, control = tools.lastElementChild;
    if (badge.textContent !== score) badge.textContent = score;
    const s = state.session;
    badge.title = protectedUser ? "白名单用户，不发送给 Jev 分析" : self ? "自己的评论，不分析"
      : decision?.error ? `${decision.error}；已保留原文，本次任务不自动重试`
      : decision ? `模型估计值 · 置信度 ${Math.round(decision.confidence * 100)}%${decision.blockReasons?.length ? ` · 未自动屏蔽：${decision.blockReasons.join("；")}` : ""}${history?.status === "failed" ? " · 屏蔽提交失败，请在垃圾桶查看记录" : ""}`
      : post.handle === s.root.handle ? "原作者，按所选任务直接屏蔽"
      : s.excluded.includes(post.handle) ? "该用户已从本次自动任务中排除"
      : state.modelError ? `分析服务需处理：${state.modelError}`
      : state.settings.paused || s.paused ? "分析已暂停"
      : busy.has(`${s.id}:${post.id}`) ? "正在分析这条评论"
      : !post.conversationId || !ancestors(post, s.root) ? "缺少父评论上下文，暂不分析；加载对应回复后会继续"
      : !post.text.trim() ? "没有可分析的文字"
      : "等待分析这条评论";
    const pending = manualPending.has(`${viewer()}:${post.handle}`) || ["pending", "running", "undo_pending", "undo_running"].includes(history?.status);
    const label = pending ? "处理中" : "加入屏蔽";
    if (control.textContent !== label) control.textContent = label;
    control.disabled = !!(pending || protectedUser || self || isBlocked(history));
    control.title = protectedUser ? "该用户在白名单中" : self ? "不能屏蔽自己" : `屏蔽 @${post.handle}，同时移除其其他回复`;
    control.setAttribute("aria-label", `加入屏蔽 @${post.handle}`);
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
      const effect = debug ? debugEffect : state.settings.animationEffect;
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
    trash.hidden = !featureEnabled() && !(animationDebug && debugRows.size);
    alignTrash();
    const s = state?.session;
    const count = state?.history.filter(h => ["blocked", "submitted"].includes(h.status)).length || 0;
    badge.textContent = count > 99 ? "99+" : String(count); badge.hidden = !count;
    status.hidden = !featureEnabled();
    if (!status.hidden) {
      const paused = state.settings.paused || s.paused;
      statusText.textContent = state.modelError || state.queueError || state.queueNotice ? "任务需处理 · 打开垃圾桶查看" : paused ? "已暂停"
        : !threadEnabled() ? "已离开评论区 · 已入队账号继续后台提交"
        : !pageReady ? loadNote || "等待最近排序的首批评论加载"
        : !s.active ? locationError || "评论已就绪 · 正在同步任务状态"
        : loadNote || `已检查 ${s.count} 条${Object.values(s.results).some(r => r.error) ? ` · ${Object.values(s.results).filter(r => r.error).length} 条结果异常` : ""}${s.autoLoad ? " · 自动加载中" : ""}${failure ? " · 部分评论缺少上下文" : ""}`;
      pause.textContent = state.settings.paused ? "继续" : "暂停";
      autoLoad.textContent = s.autoLoad ? "自动加载：开" : "自动加载：关";
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
    const chat = [...document.querySelectorAll('button[aria-label="聊天"],button[aria-label="Chat"],[role="button"][aria-label="聊天"],[role="button"][aria-label="Chat"]')]
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
      if (previousState && (previousState.modelError && !state.modelError || previousState.settings.paused && !state.settings.paused || previousState.settings.analysisRevision !== state.settings.analysisRevision)) skipped.clear();
      if (sessionId !== (state.session?.id || "")) {
        sessionId = state.session?.id || ""; skipped.clear(); failure = ""; lastLocation = ""; locationRetryAt = 0; locationError = "";
        pageReady = false; sortFlow = null; loadWait = null; loadNote = ""; autoAt = 0;
        // Starting a task must discover existing cards without waiting for a scroll or request.
        if (sessionId) window.postMessage({ channel: "blocksb:replay:v1" }, location.origin);
      }
      updateOverlay(); schedule();
    } catch (e) { statusText.textContent = e.message; }
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
    const recentLabel = /^(最近|最新|Most recent|Recent|Latest)$/i;
    const sortLabel = /^(相关|相關|最近|最新|喜欢|喜歡|Relevant|Most relevant|Most recent|Recent|Latest|Likes|Most liked)$/i;
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
      pageReady = false; loadNote = "正在通过页面菜单切换为最近排序";
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
      if (now - flow.started > 12000) loadNote = "未能自动选择排序，请在 X 菜单中选择最近，任务会自动继续";
      return;
    }
    // Errors and stale first-page signals never authorize work, including after a manual sort change.
    if (fresh && event?.recent && !event.ok) { pageReady = false; loadNote = `评论加载失败${event.status ? `（HTTP ${event.status}）` : ""}，请在 X 页面重试`; return; }
    const loading = !!document.querySelector('[data-testid="primaryColumn"] [role="progressbar"]');
    const settledDOM = recent && signature && !loading && now - flow.stableSince >= 800 && (!flow.clicked || signature !== flow.before);
    if (fresh && event?.recent && event.firstReady || settledDOM) {
      pageReady = true;
      if (/^(正在通过|未能自动|等待最近|评论加载失败)/.test(loadNote)) loadNote = "";
    } else if (!pageReady) loadNote = now - flow.started > 25000 ? "等待最近评论加载，请检查 X 页面是否需要重试" : "等待最近排序的首批评论加载";
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
      void stopAuto("自动加载已停止：服务或评论加载异常，请处理后重新开启"); return;
    }
    if (s.count >= 2000) { void stopAuto("自动加载已停止：本次任务达到 2000 条分析上限"); return; }
    // Drain already discovered, eligible replies before moving the viewport and triggering more pages.
    const account = viewer();
    const pending = busy.size || [...metadata.values()].some(p => {
      const token = `${s.id}:${p.id}`;
      if (!p.domSeen && !(p.networkAt > 0 && p.networkAt >= s.created)) return false;
      if (hasDecision(p) || skipped.has(token) || p.id === s.root.id || p.handle === account || p.handle === s.root.handle || white(p) || s.excluded.includes(p.handle) || isBlocked(historyFor(p, account)) || !p.text.trim()) return false;
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
      .find(b => /^(显示可能的垃圾信息|显示可能的垃圾消息|Show probable spam)$/i.test(b.textContent.trim()) && b.getBoundingClientRect().height > 0 && !openedSpam.has(b));
    if (spam) { openedSpam.add(spam); spam.click(); loadWait = null; return; }
    if (event?.ok && event.ended) { void stopAuto("已到 X 返回的列表末尾 · 已入队屏蔽继续处理"); return; }
    if (!loadWait) loadWait = { since: now, size: metadata.size, responseAt: event?.observedAt || 0 };
    else if (now - loadWait.since > 30000) { void stopAuto("30 秒没有新评论，自动加载已停止；可手动检查后重新开启"); return; }
    window.scrollBy({ top: Math.max(240, innerHeight * .8), behavior: "instant" });
  }
  function scan() {
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
    if (animationDebug) return;
    const s = state.session, account = viewer(), rootId = route();
    const rows = articles();
    prepareThread(rows);
    if (state.account !== account) { void refresh(); return; }
    const candidateRoot = rows.map(readPost).find(p => p?.id === s?.root.id) || metadata.get(s?.root.id);
    const focal = candidateRoot?.handle === s?.root.handle ? candidateRoot : null;
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
          if (state.session?.id === s.id) { lastLocation = ""; locationRetryAt = Date.now() + 2500; locationError = `任务状态同步失败：${e.message}`; }
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
      const queued = ["pending", "running"].includes(h?.status);
      const hide = taskMayHide(p, h) && (isBlocked(h) || queued) && !white(p) && p.handle !== account;
      if (old && !hide && ["failed", "uncertain"].includes(h?.status) && !reportedFailures.has(h.id)) {
        reportedFailures.add(h.id); toast(`@${p.handle} 屏蔽未完成，已恢复评论；请在垃圾桶中查看记录。`);
      }
      if (old && (old.id !== p.id || !hide || old.mode !== "removed")) restore(article);
      if (hide) { removeCard(article, p, queued || ["blocked", "submitted"].includes(h.status) && Date.now() - h.updated < 6000); continue; }
      commentTools(article, p, decision, h, rootId);
      maskCard(article, p, decision);
    }
    // Existing candidates come from DOM scans. New responses may add candidates after activation;
    // replayed old network data supplies context only. Both paths share deduplication and ancestry checks.
    if (active && !state.modelError && state.settings.configured) for (const p of metadata.values()) {
      if (busy.size >= 2) break;
      if (!p.domSeen && !(p.networkAt > 0 && p.networkAt >= s.created)) continue;
      if (hasDecision(p) || busy.has(`${s.id}:${p.id}`) || p.id === s.root.id || p.handle === account || p.handle === s.root.handle || white(p) || s.excluded.includes(p.handle) || isBlocked(historyFor(p, account))) continue;
      if (!p.conversationId || p.conversationId !== s.root.conversationId) continue;
      const chain = ancestors(p, s.root);
      if (!chain) { failure = "context"; continue; }
      const token = `${s.id}:${p.id}`; busy.add(token);
      const fingerprint = `${p.text}|${p.parentId}|${chain[0]?.text || ""}`;
      if (skipped.get(token) === fingerprint) { busy.delete(token); continue; }
      const analysisRevision = state.settings.analysisRevision;
      send("CLASSIFY", { sessionId: s.id, account, reply: p, parent: chain[0] || null, ancestors: chain }).then(result => {
        if (state.settings.analysisRevision !== analysisRevision) return;
        if (state.session?.id === s.id && result.action !== "skip") state.session.results[p.id] = result;
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
  document.addEventListener("scroll", schedule, { passive: true, capture: true });
  window.addEventListener("resize", schedule, { passive: true });
  let previous = "";
  // Restore rows immediately on route/account changes, even while a background snapshot is pending.
  setInterval(() => { alignTrash(); const key = `${location.href}|${viewer()}`; if (key !== previous) { previous = key; schedule(); void refresh(); } else if (featureEnabled()) schedule(); }, 900);
  chrome.runtime.onMessage.addListener(message => { if (message?.type === "STATE_CHANGED") { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 100); } });
  void refresh();
})();
