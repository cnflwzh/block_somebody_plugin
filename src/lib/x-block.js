import { normalizeHandle, numericId } from "./core.js";

const bearer = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

/** Read only the active account ID and CSRF token from the permitted X origin.
 * Tokens stay in worker memory, never in jobs, snapshots, exports or Jev requests.
 */
export async function xSession(origin = "https://x.com") {
  if (!["https://x.com", "https://twitter.com"].includes(origin)) throw new Error("无效的 X 来源。");
  const [csrf, twid] = await Promise.all(["ct0", "twid"].map(name => chrome.cookies.get({ url: origin, name })));
  let value = "";
  try { value = decodeURIComponent(twid?.value || "").replace(/^"|"$/g, ""); } catch { /* Invalid cookie: require login again. */ }
  const actorId = numericId(value.match(/^u=(\d+)$/)?.[1]);
  if (!csrf?.value || !actorId) throw new Error("X 登录状态不可用，请登录后再恢复队列。");
  return { origin, actorId, csrf: csrf.value };
}

/** Submit exactly one block POST; HTTP success is acceptance, not relationship verification.
 * Returns an accepted result or a failure with status/retry delay. Never retries or reads relationships.
 */
export async function postBlock(target, session) {
  const userId = numericId(target.userId), handle = normalizeHandle(target.handle);
  if (userId === session.actorId) return { ok: false, error: "不能屏蔽当前登录账号。" };
  let response;
  try {
    response = await fetch(`${session.origin}/i/api/1.1/blocks/create.json`, {
      method: "POST", credentials: "include", redirect: "error", signal: AbortSignal.timeout(12000),
      headers: { authorization: bearer, "x-csrf-token": session.csrf, "x-twitter-auth-type": "OAuth2Session", "x-twitter-active-user": "yes", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(userId ? { user_id: userId } : { screen_name: handle }).toString()
    });
  } catch { return { ok: false, error: "屏蔽请求超时或连接中断，未收到 HTTP 成功响应；未自动重试。" }; }
  const retry = response.headers.get("retry-after");
  const retryAfterMs = retry ? Math.max(0, /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) || 0 : response.status === 429 ? 60000 : 0;
  // Empty/non-JSON 2xx bodies are accepted. An explicit API error is still a failure.
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.errors?.length || data?.error) {
    const messages = { 401: "X 登录已失效，请登录后恢复队列。", 403: "X 拒绝此次请求，请检查账号状态。", 404: "X 接口或目标账号不可用。", 429: "X 暂时限流，队列已暂停。" };
    return { ok: false, status: response.status, retryAfterMs, pauseQueue: [401, 403, 429].includes(response.status),
      error: `屏蔽请求失败（HTTP ${response.status}）。${messages[response.status] || (response.ok ? "X 返回了错误信息。" : "可在记录中手动重试。")}` };
  }
  return { ok: true, accepted: true, status: response.status, target };
}
