import { fetchReplyTimeline, parseReplyTimeline, completeReplyContexts } from "./x-replies.js";
import { reserveReplyPage, pauseReplyPages } from "./observer-store.js";

let serial = Promise.resolve();
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("Collection cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  });
}
/** Fetch one page through a worker-wide serial lane. A short inter-request delay is
 * awaited; long rate limits return immediately instead of tying up observation slots.
 */
async function page(binding, userId, cursor, signal, permitted) {
  const run = serial.then(async () => {
    if (signal.aborted || !await permitted()) throw new Error("Collection cancelled");
    let slot = await reserveReplyPage(binding.actorId);
    if (!slot.allowed && slot.retryAt - Date.now() <= 3100) {
      await delay(Math.max(1, slot.retryAt - Date.now()), signal);
      if (!await permitted()) throw new Error("Collection cancelled");
      slot = await reserveReplyPage(binding.actorId);
    }
    if (!slot.allowed) throw Object.assign(new Error("Collection paused"), { status: 429, retryAt: slot.retryAt });
    try { return await fetchReplyTimeline(binding, userId, cursor, signal); }
    catch (error) {
      if ([401, 403, 404, 429].includes(error.status)) {
        error.retryAt = error.status === 429 ? error.retryAt : Date.now() + 3600000;
        await pauseReplyPages(binding.actorId, error.retryAt);
      }
      throw error;
    }
  });
  serial = run.catch(() => {});
  return run;
}
/** Collect at most two pages, stopping once enough usable replies and roots exist.
 * `accept` rechecks protections and combines fetched candidates with local observations.
 * Returns complete contexts only. No Jev calls, navigation, or account mutations occur.
 */
export async function collectRecentReplies({ binding, userId, account, config, signal, permitted, accept }) {
  const posts = new Map(), cursors = new Set(); let cursor = "", contexts = [], profile = null;
  for (let number = 0; number < 2; number++) {
    let data;
    try { data = await page(binding, userId, cursor, signal, permitted); }
    catch (error) {
      // Later-page failures must not discard already accepted complete samples.
      // Authentication/cancellation still invalidates the whole collection.
      if (!contexts.length || signal.aborted || error.code === "REPLIES_CANCELLED" || [401, 403].includes(error.status) || !await permitted()) throw error;
      break;
    }
    if (signal.aborted || !await permitted()) throw new Error("Collection cancelled");
    const parsed = parseReplyTimeline(data, account);
    profile = parsed.profiles.get(userId) || profile;
    for (const [id, post] of parsed.posts) if (!posts.has(id) || posts.get(id).incomplete) posts.set(id, post);
    contexts = completeReplyContexts(posts, userId, config.retentionDays);
    if (await accept(contexts, profile)) break;
    if (!parsed.cursor || cursors.has(parsed.cursor)) break;
    cursor = parsed.cursor; cursors.add(cursor);
  }
  return contexts;
}
