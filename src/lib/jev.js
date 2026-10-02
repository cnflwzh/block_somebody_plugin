import { DEFAULT_ENDPOINT, normalizeEndpoint, endpointPermission } from "./core.js";

/** Read a small classification response with a byte limit, including chunked responses.
 * Reject oversized output before JSON parsing; cancel its stream to release network resources.
 */
async function readAnswer(response) {
  const limit = 256 * 1024;
  const oversized = () => Object.assign(new Error("Jev 返回结果过大，已跳过此评论。"), { code: "JEV_INVALID_ANSWER" });
  if (Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel().catch(() => {});
    throw oversized();
  }
  const reader = response.body?.getReader();
  if (!reader) throw Object.assign(new Error("Jev 返回了空结果。"), { code: "JEV_INVALID_ANSWER" });
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
    catch { throw Object.assign(new Error("Jev 返回了无法读取的结果。"), { code: "JEV_INVALID_ANSWER" }); }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Send a Jev-format request to an explicitly configured HTTPS endpoint.
 * Requires a granted host permission; omits cookies and rejects redirects. Never logs credentials.
 */
export async function askJev(request, apiKey, signal, endpoint = DEFAULT_ENDPOINT) {
  if (!apiKey) throw new Error("请先在设置中填写 Jev API Key。");
  endpoint = normalizeEndpoint(endpoint);
  if (endpoint !== DEFAULT_ENDPOINT && !await chrome.permissions.contains({ origins: [endpointPermission(endpoint)] })) throw new Error("未授权访问 API 端点，请在模型设置中重新保存并授权。");
  if (signal?.aborted) throw new Error("分析已取消。");
  const timeout = AbortSignal.timeout(22000);
  let response;
  try {
    response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(request), signal: signal ? AbortSignal.any([timeout, signal]) : timeout, credentials: "omit", redirect: "error" });
  } catch (e) {
    if (signal?.aborted) throw new Error("分析已取消。");
    throw new Error(e.name === "TimeoutError" ? "Jev 响应超时，评论保持原样。" : "暂时无法连接 Jev，评论保持原样。");
  }
  if (!response.ok) {
    const messages = { 401: "Jev 密钥无效，请重新设置。", 402: "Jev 余额不足，请检查账户。", 403: "Jev 拒绝访问，请检查账户权限。", 429: "Jev 暂时限流，已暂停分析，请稍后重试。" };
    throw new Error(messages[response.status] || `Jev 返回 HTTP ${response.status}，评论保持原样。`);
  }
  try { return await readAnswer(response); }
  catch (error) {
    if (signal?.aborted) throw new Error("分析已取消。");
    if (error.code === "JEV_INVALID_ANSWER") throw error;
    throw new Error(timeout.aborted ? "Jev 响应超时，评论保持原样。" : "Jev 响应中断，评论保持原样。");
  }
}
