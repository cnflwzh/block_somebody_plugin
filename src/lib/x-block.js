import "./i18n.js";
const { t } = globalThis.BlockSBI18n;
import { normalizeHandle, numericId } from "./core.js";

const bearer = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

/** Read only the active account ID and CSRF token from the permitted X origin.
 * Tokens stay in worker memory, never in jobs, snapshots, exports or Jev requests.
 */
export async function xSession(origin = "https://x.com") {
  if (!["https://x.com", "https://twitter.com"].includes(origin)) throw new Error(t("ui_invalid_x_origin"));
  const [csrf, twid] = await Promise.all(["ct0", "twid"].map(name => chrome.cookies.get({ url: origin, name })));
  let value = "";
  try { value = decodeURIComponent(twid?.value || "").replace(/^"|"$/g, ""); } catch { /* Invalid cookie: require login again. */ }
  const actorId = numericId(value.match(/^u=(\d+)$/)?.[1]);
  if (!csrf?.value || !actorId) throw new Error(t("ui_x_session_unavailable_sign_in_before_resuming_the_queue"));
  return { origin, actorId, csrf: csrf.value };
}

/** Submit exactly one block POST; HTTP success is acceptance, not relationship verification.
 * Returns an accepted result or a failure with status/retry delay. Never retries or reads relationships.
 */
export async function postBlock(target, session) {
  const userId = numericId(target.userId), handle = normalizeHandle(target.handle);
  if (userId === session.actorId) return { ok: false, error: t("ui_cannot_block_the_currently_signed_in_account") };
  let response;
  try {
    response = await fetch(`${session.origin}/i/api/1.1/blocks/create.json`, {
      method: "POST", credentials: "include", redirect: "error", signal: AbortSignal.timeout(12000),
      headers: { authorization: bearer, "x-csrf-token": session.csrf, "x-twitter-auth-type": "OAuth2Session", "x-twitter-active-user": "yes", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(userId ? { user_id: userId } : { screen_name: handle }).toString()
    });
  } catch { return { ok: false, error: t("ui_block_request_timed_out_or_disconnected_without_http_success_not") }; }
  const retry = response.headers.get("retry-after");
  const retryAfterMs = retry ? Math.max(0, /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) || 0 : response.status === 429 ? 60000 : 0;
  // Empty/non-JSON 2xx bodies are accepted. An explicit API error is still a failure.
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.errors?.length || data?.error) {
    const messages = { 401: t("ui_x_session_expired_sign_in_to_resume_the_queue"), 403: t("ui_x_refused_the_request_check_your_account_status"), 404: t("ui_x_endpoint_or_target_account_is_unavailable"), 429: t("ui_x_rate_limit_reached_queue_paused") };
    return { ok: false, status: response.status, retryAfterMs, pauseQueue: [401, 403, 429].includes(response.status),
      error: t("ui_block_request_failed_http", response.status, messages[response.status] || (response.ok ? t("ui_x_returned_an_error") : t("ui_you_can_retry_manually_in_history"))) };
  }
  return { ok: true, accepted: true, status: response.status, target };
}
