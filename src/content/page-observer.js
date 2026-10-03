/* Page-world bridge: scan existing DOM cards and observe subsequent X responses. No account actions. */
(() => {
  /** MAIN-world code cannot authorize debug actions; console helpers only open the panel. */
  const debugCommand = () => {
    window.postMessage({ channel: "blocksb:animation-debug:v1", command: "enable" }, location.origin);
    console.info("[block s.b.] 已请求打开调试面板。请在面板中点击开关、选择动画或退出调试；控制台命令不会改变任务或屏蔽状态。");
  };
  Object.defineProperty(window, "blockSBDebug", { configurable: true, value: Object.freeze({
    enable: debugCommand,
    // Keep legacy names as panel-opening aliases, without their former side effects.
    dryRun: debugCommand, play: debugCommand, reset: debugCommand, disable: debugCommand
  }) });
  const records = new Map(), domSignatures = new Map();
  // Relationship flags describe the signed-in viewer, never the author's followers.
  const viewer = () => {
    const text = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.innerText || "";
    const handles = [...new Set([...text.matchAll(/(?:^|\s)@([a-zA-Z0-9_]{1,15})(?=\s|$)/g)].map(m => m[1].toLowerCase()))];
    return handles.length === 1 ? handles[0] : "";
  };
  const following = user => {
    for (const value of [user?.relationship_perspectives?.following, user?.following, user?.legacy?.following]) {
      if (typeof value === "boolean") return value;
    }
    return null; // An omitted relationship is not proof that the viewer does not follow.
  };
  /** Sparse blocked cards must not overwrite the full post previously observed on this page. */
  function remember(post) {
    const previous = records.get(post.id);
    if (previous?.handle === post.handle) {
      const keepText = previous.text && (!post.text || !previous.incomplete && post.incomplete);
      post = { ...post, userId: post.userId || previous.userId, conversationId: post.conversationId || previous.conversationId,
        parentId: post.parentId || previous.parentId, text: keepText ? previous.text : post.text,
        incomplete: keepText ? previous.incomplete : post.incomplete, hasMedia: post.hasMedia || previous.hasMedia };
    }
    records.delete(post.id); records.set(post.id, post);
    return post;
  }
  const channel = "blocksb:metadata:v1";
  const timelines = new Map();
  const xhrUrls = new WeakMap();
  /** Observe X's own first-page/pagination completion; never request pages ourselves. */
  function timeline(responseUrl, data, status, startedAt) {
    try {
      const url = new URL(responseUrl, location.href);
      if (!eligible(url.href) || !url.pathname.endsWith("/TweetDetail")) return;
      const variables = JSON.parse(url.searchParams.get("variables") || "{}");
      if (!/^\d{5,25}$/.test(variables.focalTweetId || "")) return;
      const recent = variables.rankingMode === "Recency";
      const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions;
      const ok = status >= 200 && status < 300 && !data?.errors?.length && Array.isArray(instructions);
      const key = variables.focalTweetId;
      const old = timelines.get(key);
      if (old && startedAt < old.startedAt) return; // Ignore an older request arriving after a sort change.
      const event = { channel: "blocksb:timeline:v1", rootId: key, recent, ok, startedAt,
        firstStartedAt: !variables.cursor ? startedAt : old?.recent === recent ? old.firstStartedAt : 0,
        firstPage: !variables.cursor, firstReady: !variables.cursor ? ok : old?.recent === recent && !!old.firstReady,
        ended: ok && instructions.some(i => i.type === "TimelineTerminateTimeline" && i.direction === "Bottom"),
        status, observedAt: Date.now() };
      timelines.set(key, event);
      while (timelines.size > 20) timelines.delete(timelines.keys().next().value);
      window.postMessage(event, location.origin);
    } catch { /* Unexpected X schema: wait for DOM evidence, never claim loading is complete. */ }
  }
  const eligible = url => { try { const u = new URL(url, location.href); return u.origin === location.origin && /\/i\/api\/graphql\//.test(u.pathname); } catch { return false; } };
  const publish = (posts, source) => window.postMessage({ channel, posts, source, observedAt: Date.now() }, location.origin);
  /** Read only tweet props attached to rendered cards; no global store, cookies or private profile data. */
  function captureRendered(force = false) {
    const found = [], account = viewer();
    for (const article of document.querySelectorAll('[data-testid="primaryColumn"] article[data-testid="tweet"]')) {
      const date = article.querySelector('[data-testid="User-Name"] time') || article.querySelector("time");
      const ownLink = date?.closest("a")?.getAttribute("href")?.match(/^\/(\w{1,15})\/status\/(\d+)/);
      if (!ownLink) continue;
      const key = Object.keys(article).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
      let fiber = key && article[key];
      for (let depth = 0; fiber && depth < 35; depth++, fiber = fiber.return) {
        const tweet = fiber.memoizedProps?.tweet;
        if (String(tweet?.id_str) !== ownLink[2] || tweet.user?.screen_name?.toLowerCase() !== ownLink[1].toLowerCase()) continue;
        const note = tweet.note_tweet?.note_tweet_results?.result || tweet.note_tweet;
        const text = String(note?.text || tweet.full_text || tweet.text || "");
        const post = { id: String(tweet.id_str), handle: tweet.user.screen_name.toLowerCase(), userId: String(tweet.user.id_str || ""),
          name: String(tweet.user.name || tweet.user.screen_name), text: text.slice(0, 14000), conversationId: String(tweet.conversation_id_str || ""),
          parentId: String(tweet.in_reply_to_status_id_str || ""), hasMedia: !!(tweet.extended_entities?.media?.length || tweet.entities?.media?.length || tweet.quoted_status || tweet.card),
          incomplete: !!tweet.truncated || text.length > 14000, following: following(tweet.user), followingAccount: account,
          blocking: typeof tweet.user.blocking === "boolean" ? tweet.user.blocking : null };
        // Force a DOM inventory on activation, even if the same card was cached before the click.
        const signature = JSON.stringify(post);
        if (force || domSignatures.get(post.id) !== signature) {
          domSignatures.set(post.id, signature); found.push(remember({ ...post, followingAt: Date.now() }));
        }
        break;
      }
    }
    while (records.size > 2500) records.delete(records.keys().next().value);
    while (domSignatures.size > 2500) domSignatures.delete(domSignatures.keys().next().value);
    for (let i = 0; i < found.length; i += 40) publish(found.slice(i, i + 40), "dom");
  }
  let renderedTimer;
  function scheduleRendered() {
    if (renderedTimer) return;
    renderedTimer = setTimeout(() => { renderedTimer = null; captureRendered(); }, 200);
  }
  const renderedObserver = new MutationObserver(changes => {
    if (changes.some(change => {
      const node = change.target.nodeType === 1 ? change.target : change.target.parentElement;
      const owned = "#blocksb-overlay,.blocksb-comment-tools,.blocksb-comment-mask,.blocksb-flying-card,.blocksb-menu-item";
      if (node?.closest?.(owned)) return false;
      const changed = [...change.addedNodes, ...change.removedNodes];
      if (changed.length && changed.every(n => n.nodeType === 1 && n.matches(owned))) return false;
      // Sidebars, counters and our own annotations must not repeatedly walk every React card.
      const column = '[data-testid="primaryColumn"]';
      return !!node?.closest?.(column) || changed.some(n => n.nodeType === 1 && (n.matches(column) || n.querySelector(column)));
    })) scheduleRendered();
  });
  renderedObserver.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  scheduleRendered();
  function ingest(data, account, startedAt) {
    const pending = [data], seen = new Set(), found = [];
    let count = 0;
    while (pending.length && count++ < 45000) {
      const item = pending.pop();
      if (!item || typeof item !== "object" || seen.has(item)) continue;
      seen.add(item);
      const legacy = item.legacy;
      const user = item.core?.user_results?.result;
      if (item.rest_id && legacy?.conversation_id_str && user) {
        const profile = user.legacy || {};
        const handle = user.core?.screen_name || profile.screen_name;
        const note = item.note_tweet?.note_tweet_results?.result;
        if (/^\w{1,15}$/.test(handle || "")) {
          const post = { id: String(item.rest_id), handle: handle.toLowerCase(), userId: String(user.rest_id || legacy.user_id_str || ""),
            name: user.core?.name || profile.name || handle, text: String(note?.text || legacy.full_text || "").slice(0, 14000),
            conversationId: String(legacy.conversation_id_str), parentId: String(legacy.in_reply_to_status_id_str || ""),
            hasMedia: !!(legacy.extended_entities?.media?.length || legacy.entities?.media?.length || item.quoted_status_result || item.card),
            incomplete: !!legacy.truncated || !!item.is_translatable && !legacy.full_text || (note?.text || legacy.full_text || "").length > 14000,
            following: following(user), followingAccount: account, followingAt: startedAt,
            blocking: typeof profile.blocking === "boolean" ? profile.blocking : null };
          found.push(remember(post));
        }
      }
      for (const value of Object.values(item)) if (value && typeof value === "object") pending.push(value);
    }
    while (records.size > 2500) records.delete(records.keys().next().value);
    for (let i = 0; i < found.length; i += 40) publish(found.slice(i, i + 40), "network");
  }
  async function capture(response, url, startedAt, account) {
    let reader, complete = false;
    try {
      if (!response.ok) { timeline(url, null, response.status, startedAt); void response.body?.cancel().catch(() => {}); return; }
      if (Number(response.headers.get("content-length")) > 6_000_000) { void response.body?.cancel().catch(() => {}); return; }
      reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let body = "", size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { complete = true; break; }
        size += value.byteLength;
        if (size > 6_000_000) return;
        body += decoder.decode(value, { stream: true });
      }
      const data = JSON.parse(body + decoder.decode());
      ingest(data, account && viewer() === account ? account : "", startedAt);
      timeline(url, data, response.status, startedAt);
    } catch { /* X responses and stream cancellation must not affect the page. */ }
    finally {
      // Do not await cancellation of a cloned response: its other branch belongs to X.
      if (reader) { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    const observe = eligible(url), startedAt = Date.now(), account = observe ? viewer() : "";
    const result = Reflect.apply(originalFetch, this, args);
    if (observe) result.then(response => capture(response.clone(), url, startedAt, account)).catch(() => timeline(url, null, 0, startedAt));
    return result;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const observed = new WeakSet();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    xhrUrls.set(this, String(url));
    if (eligible(url)) observed.add(this); else observed.delete(this);
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const startedAt = Date.now(), url = xhrUrls.get(this), account = observed.has(this) ? viewer() : "";
    // loadend also runs on abort/error, so reused XHR objects cannot retain stale listeners.
    if (observed.has(this)) this.addEventListener("loadend", () => {
      try {
        if (this.status < 200 || this.status >= 300) { timeline(url, null, this.status, startedAt); return; }
        const data = this.responseType === "json" ? this.response
          : (!this.responseType || this.responseType === "text") && this.responseText.length <= 6_000_000 ? JSON.parse(this.responseText) : null;
        if (data) { ingest(data, account && viewer() === account ? account : "", startedAt); timeline(url, data, this.status, startedAt); }
      } catch { /* Passive observation only. */ }
    }, { once: true });
    return Reflect.apply(originalSend, this, args);
  };
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== "blocksb:replay:v1") return;
    captureRendered(true);
    for (const event of timelines.values()) window.postMessage(event, location.origin);
    const all = [...records.values()];
    // Cached responses can supply missing parents, but are not newly arrived comments.
    for (let i = 0; i < all.length; i += 40) publish(all.slice(i, i + 40), "cache");
  });
})();
