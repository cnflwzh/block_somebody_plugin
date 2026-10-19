import { numericId, sanitizePost, validateThread } from "./core.js";
import { xSession, xReadHeaders } from "./x-block.js";
import { REPLIES_QUERY } from "./x-replies-query.js";
import { publicAccountProfile } from "./account-signals.js";

/** Parse only timeline tweets, excluding quoted/retweeted/promoted content. Returns a
 * bounded post map and a pagination cursor; neither avatars nor credentials are retained.
 * Parent edges, not visual order, determine context. Unknown shapes yield no samples.
 */
export function parseReplyTimeline(data, account, now = Date.now()) {
  const posts = new Map(), profiles = new Map(); let cursor = "", visited = 0;
  function walk(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 40 || ++visited > 20000 || value.promotedMetadata || value.promoted_metadata) return;
    if (value.cursorType === "Bottom" && typeof value.value === "string" && value.value.length < 2048) cursor = value.value;
    if (value.__typename === "Tweet") {
      const l = value.legacy, user = value.core?.user_results?.result;
      if (!l || !user || l.retweeted_status_result) return;
      if (numericId(user.rest_id)) profiles.set(user.rest_id, publicAccountProfile(user));
      const note = value.note_tweet?.note_tweet_results?.result?.text;
      const text = typeof note === "string" ? note : l.full_text;
      try {
        const post = sanitizePost({ id: value.rest_id, userId: user.rest_id, handle: user.core?.screen_name || user.legacy?.screen_name,
          name: user.core?.name || user.legacy?.name, text, conversationId: l.conversation_id_str, parentId: l.in_reply_to_status_id_str,
          incomplete: (typeof note !== "string" && !!l.truncated) || typeof text !== "string" || text.length > 14000,
          hasMedia: !!(l.extended_entities?.media?.length || l.entities?.media?.length || value.card || value.quoted_status_result),
          blueVerified: user.is_blue_verified, following: user.relationship_perspectives?.following ?? user.legacy?.following,
          followingAccount: account, followingAt: now });
        post.createdAt = Date.parse(l.created_at) || 0;
        if (!posts.has(post.id) || posts.get(post.id).incomplete) posts.set(post.id, post);
      } catch { /* Unavailable/tombstoned/malformed posts cannot establish context. */ }
      return; // Do not descend into quotes, cards or user objects.
    }
    for (const [key, child] of Object.entries(value)) if (!['quoted_status_result', 'retweeted_status_result', 'promotedMetadata', 'card'].includes(key)) walk(child, depth + 1);
  }
  walk(data?.data?.user?.result?.timeline_v2 || data?.data?.user?.result?.timeline);
  return { posts, profiles, cursor };
}

/** Select complete reply chains for one stable author. Missing roots/parents, cycles,
 * self-threads and incomplete text are skipped; no extra endpoint is guessed to fill gaps.
 */
export function completeReplyContexts(posts, userId, retentionDays, now = Date.now()) {
  const results = [];
  for (const reply of posts.values()) {
    if (reply.userId !== userId || !reply.parentId || !reply.text.trim() || reply.createdAt < now - retentionDays * 86400000 || reply.createdAt > now + 60000) continue;
    const root = posts.get(reply.conversationId), ancestors = [], seen = new Set([reply.id]);
    if (!root || root.parentId || root.userId === userId) continue;
    let next = reply.parentId;
    while (next && next !== root.id && !seen.has(next) && ancestors.length < 30) {
      seen.add(next); const parent = posts.get(next); if (!parent) break;
      ancestors.push(parent); next = parent.parentId;
    }
    if (!validateThread(root, reply, ancestors) || [root, reply, ...ancestors].some(p => p.incomplete || !p.text.trim() && !p.hasMedia)) continue;
    results.push({ root, reply, ancestors });
  }
  return results.sort((a, b) => b.reply.createdAt - a.reply.createdAt);
}

/** One bounded, read-only request from the extension worker. Verifies the active login
 * before and after fetching, never accepts an arbitrary URL, and never retries itself.
 * Throws with status/retryAt on API failure; callers persist backoff before trying later.
 */
export async function fetchReplyTimeline(binding, userId, cursor, signal) {
  if (!numericId(userId)) throw new Error("Invalid target ID");
  const session = await xSession(binding.origin);
  if (session.actorId !== binding.actorId) throw Object.assign(new Error("X account changed"), { code: "REPLIES_CANCELLED" });
  const url = new URL(REPLIES_QUERY.path, session.origin);
  url.searchParams.set("variables", JSON.stringify({ userId, count: 20, includePromotedContent: false, withCommunity: true, withVoice: true, ...(cursor ? { cursor } : {}) }));
  url.searchParams.set("features", JSON.stringify(REPLIES_QUERY.features));
  url.searchParams.set("fieldToggles", JSON.stringify(REPLIES_QUERY.fieldToggles));
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 12000);
  try {
    const response = await fetch(url.href, { credentials: "include", redirect: "error", headers: xReadHeaders(session), signal: controller.signal });
    const retry = response.headers.get("retry-after"), reset = Number(response.headers.get("x-rate-limit-reset")) * 1000;
    const retryAt = Math.max(Date.now() + 60000, /^\d+$/.test(retry || "") ? Date.now() + Number(retry) * 1000 : Date.parse(retry) || 0, Number.isFinite(reset) ? reset : 0);
    if (!response.ok) throw Object.assign(new Error("Recent replies unavailable"), { status: response.status, retryAt });
    // Bound decompressed response size as well as duration. An unexpected large response
    // must not occupy the worker indefinitely or be stored as raw account history.
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("Reply response too large"); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (data.errors?.length || !data.data?.user?.result) throw Object.assign(new Error("Reply response unavailable"), { status: data.errors?.some(e => e.code === 88) ? 429 : 502, retryAt });
    if (controller.signal.aborted || (await xSession(binding.origin)).actorId !== binding.actorId) throw Object.assign(new Error("X account changed"), { code: "REPLIES_CANCELLED" });
    return data;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
