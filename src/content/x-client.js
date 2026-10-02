/* Isolated-world X adapter. The page bridge cannot request mutations or access credentials. */
(() => {
  const bearer = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  /** Return the visibly selected account; ambiguous account-switcher markup fails closed. */
  function viewer() {
    const node = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const values = [...(node?.innerText || "").matchAll(/(?:^|\s)@([a-zA-Z0-9_]{1,15})(?=\s|$)/g)].map(m => m[1].toLowerCase());
    return new Set(values).size === 1 ? values[0] : "";
  }
  function accountMatches(account) {
    if (!account || viewer() !== account) throw new Error("当前登录账号无法确认或已经切换，操作已停止。");
  }
  async function permission(type, job, baseline) {
    const result = await chrome.runtime.sendMessage({ type, jobId: job.id, baseline });
    if (!result?.ok) throw new Error(result?.error || "后台无法确认操作许可。");
    return result.data === true;
  }
  /** Same-origin requests, existing login only. Never export X cookies to the worker or Jev. */
  async function request(path, method = "GET", body) {
    const csrf = document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith("ct0="))?.slice(4);
    if (!csrf) throw new Error("X 登录会话已失效，请刷新并重新登录。");
    let response;
    try {
      response = await fetch(new URL(path, location.origin), { method, credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(12000),
        headers: { authorization: bearer, "x-csrf-token": csrf, "x-twitter-auth-type": "OAuth2Session", "x-twitter-active-user": "yes", "Content-Type": "application/x-www-form-urlencoded" }, body });
    } catch { throw Object.assign(new Error("X 请求超时或连接中断。"), { uncertain: method === "POST" }); }
    const retry = response.headers.get("retry-after");
    const retryAfterMs = retry ? Math.max(0, /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : response.status === 429 ? 60000 : 0;
    let data;
    try { data = await response.json(); } catch { throw Object.assign(new Error("X 返回了无法核对的结果。"), { uncertain: method === "POST", retryAfterMs }); }
    if (!response.ok || data.errors?.length) {
      const messages = { 401: "X 登录已失效。", 403: "X 拒绝此次操作，请检查账号状态。", 404: "X 接口或目标账号不可用。", 429: "X 暂时限流，队列已暂停。" };
      throw Object.assign(new Error(messages[response.status] || `X 操作失败（HTTP ${response.status}）。`), { uncertain: method === "POST" && response.status >= 500, retryAfterMs, status: response.status });
    }
    return data;
  }
  function identity(data, target) {
    const handle = String(data.screen_name || "").toLowerCase(), userId = String(data.id_str || "");
    if (handle !== target.handle || !/^\d{5,25}$/.test(userId) || (target.userId && target.userId !== userId)) throw new Error("目标账号身份无法核对，已停止操作。");
    return { handle, userId, name: String(data.name || handle).slice(0, 80), blocking: data.blocking };
  }
  /** Relationship reads are reserved for explicit undo and reconciliation, never automatic blocks. */
  async function inspect(account, target) {
    accountMatches(account);
    // X's user lookup currently returns 404. The relationship response supplies both identities
    // and the authenticated source's blocking flag, including after create/destroy responses omit it.
    const query = { source_screen_name: account, ...(target.userId ? { target_id: target.userId } : { target_screen_name: target.handle }) };
    const relation = await request(`/i/api/1.1/friendships/show.json?${new URLSearchParams(query)}`);
    accountMatches(account);
    const source = relation.relationship?.source, dest = relation.relationship?.target;
    if (String(source?.screen_name || "").toLowerCase() !== account || typeof source?.blocking !== "boolean") throw new Error("无法核对现有屏蔽关系，未执行操作。");
    return { ...identity(dest, target), name: target.name || dest.name || target.handle, blocking: source.blocking };
  }
  async function execute(job) {
    if (job.kind !== "unblock") return { ok: false, error: "屏蔽请求由扩展后台队列提交。" };
    let submitted = false;
    try {
      if (!await permission("ACTION_ALLOWED", job)) return { ok: false, cancelled: true };
      const target = await inspect(job.account, job.target);
      if (!await permission("ACTION_ALLOWED", job)) return { ok: false, cancelled: true };
      if (!target.blocking) return { ok: true, target };
      if (!await permission("ACTION_SUBMIT", job, target)) return { ok: false, cancelled: true };
      accountMatches(job.account);
      submitted = true;
      const data = await request("/i/api/1.1/blocks/destroy.json", "POST", new URLSearchParams({ user_id: target.userId }).toString());
      accountMatches(job.account);
      let confirmed;
      try { confirmed = identity(data, target); } catch (e) { e.uncertain = true; throw e; }
      if (confirmed.blocking !== false) {
        // A successful mutation may return a user without relationship fields. Read back once;
        // never repeat the POST just to obtain confirmation.
        confirmed = await inspect(job.account, target);
      }
      if (confirmed.blocking !== false) throw Object.assign(new Error("X 未明确确认取消屏蔽状态，请先核对结果。"), { uncertain: true });
      return { ok: true, target: confirmed };
    } catch (e) { return { ok: false, error: e.message, uncertain: e.uncertain ?? submitted, retryAfterMs: e.retryAfterMs || 0 }; }
  }
  globalThis.BlockSBX = Object.freeze({ viewer });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "GET_VIEWER") { respond({ account: viewer() }); return; }
    if (message?.type === "EXECUTE_ACTION") { execute(message.job).then(respond); return true; }
    if (message?.type === "INSPECT_TARGET") { inspect(message.account, message.target).then(target => respond({ ok: true, target }), e => respond({ ok: false, error: e.message })); return true; }
  });
})();
