import "./i18n.js";
const { t } = globalThis.BlockSBI18n;
import { DEFAULT_ENDPOINT, normalizeEndpoint, endpointPermission } from "./core.js";

/** Read a small classification response with a byte limit, including chunked responses.
 * Reject oversized output before JSON parsing; cancel its stream to release network resources.
 */
async function readAnswer(response) {
  const limit = 256 * 1024;
  const oversized = () => Object.assign(new Error(t("ui_jev_response_too_large_reply_skipped")), { code: "JEV_INVALID_ANSWER" });
  if (Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel().catch(() => {});
    throw oversized();
  }
  const reader = response.body?.getReader();
  if (!reader) throw Object.assign(new Error(t("ui_jev_returned_an_empty_result")), { code: "JEV_INVALID_ANSWER" });
  let size = 0, text = "", complete = false;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > limit) throw oversized();
      text += decoder.decode(value, { stream: true });
    }
    try { return JSON.parse(text + decoder.decode()); }
    catch { throw Object.assign(new Error(t("ui_jev_returned_an_unreadable_result")), { code: "JEV_INVALID_ANSWER" }); }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Send a Jev-format request to an explicitly configured HTTPS endpoint.
 * Requires a granted host permission; omits cookies and rejects redirects. Never logs credentials.
 */
export async function askJev(request, apiKey, signal, endpoint = DEFAULT_ENDPOINT) {
  if (!apiKey) throw new Error(t("ui_enter_your_jev_api_key_in_settings_first"));
  endpoint = normalizeEndpoint(endpoint);
  if (endpoint !== DEFAULT_ENDPOINT && !await chrome.permissions.contains({ origins: [endpointPermission(endpoint)] })) throw new Error(t("ui_api_endpoint_access_not_granted_save_and_grant_access_in"));
  if (signal?.aborted) throw new Error(t("ui_analysis_canceled"));
  const timeout = AbortSignal.timeout(22000);
  let response;
  try {
    response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(request), signal: signal ? AbortSignal.any([timeout, signal]) : timeout, credentials: "omit", redirect: "error" });
  } catch (e) {
    if (signal?.aborted) throw new Error(t("ui_analysis_canceled"));
    throw new Error(e.name === "TimeoutError" ? t("ui_jev_timed_out_reply_left_unchanged") : t("ui_cannot_connect_to_jev_right_now_reply_left_unchanged"));
  }
  if (!response.ok) {
    const messages = { 401: t("ui_invalid_jev_key_update_it_in_settings"), 402: t("ui_insufficient_jev_balance_check_your_account"), 403: t("ui_jev_denied_access_check_your_permissions"), 429: t("ui_jev_rate_limit_reached_analysis_paused_retry_later") };
    throw new Error(messages[response.status] || t("ui_jev_returned_http_reply_left_unchanged", response.status));
  }
  try { return await readAnswer(response); }
  catch (error) {
    if (signal?.aborted) throw new Error(t("ui_analysis_canceled"));
    if (error.code === "JEV_INVALID_ANSWER") throw error;
    throw new Error(timeout.aborted ? t("ui_jev_timed_out_reply_left_unchanged") : t("ui_jev_response_interrupted_reply_left_unchanged"));
  }
}
