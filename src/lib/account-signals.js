/** Versioned, deterministic account facts. These are observations, never AI scores. */
export const ACCOUNT_SIGNALS_VERSION = "account-signals-v1";
const median = values => { if (!values.length) return null; const a = [...values].sort((a, b) => a - b), m = Math.floor(a.length / 2); return Math.round((a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) * 10) / 10; };
const length = text => Array.from(text || "").length;

/** Whitelist public profile fields from X's user object; omitted fields remain unknown.
 * No avatar, location, handle, numeric identity, contact or follower list is copied.
 */
export function publicAccountProfile(user) {
  const name = user?.core?.name ?? user?.legacy?.name;
  const bio = user?.profile_bio?.description ?? user?.legacy?.description;
  return { displayName: typeof name === "string" ? name.slice(0, 80) : null,
    bio: typeof bio === "string" ? bio.slice(0, 500) : null,
    bioTruncated: typeof bio === "string" && bio.length > 500 };
}

/** Summarize up to 40 complete, eligible replies by one stable author. Inputs must have
 * passed the caller's current whitelist/relationship checks. Repeated IDs count once.
 * Every metric describes this partial observed set, not a complete posting history.
 */
export function summarizeAccountSignals(contexts, userId, profile, now = Date.now()) {
  const seen = new Map();
  for (const c of contexts) if (c.reply.userId === userId && c.reply.parentId && c.reply.createdAt > 0 && c.reply.createdAt <= now + 60000) seen.set(c.reply.id, c);
  const rows = [...seen.values()].sort((a, b) => b.reply.createdAt - a.reply.createdAt).slice(0, 40).reverse();
  const gaps = rows.slice(1).map((c, i) => (c.reply.createdAt - rows[i].reply.createdAt) / 1000);
  const followOnly = c => length(c.reply.text) <= 60 && /(?:已关注|已關注|求回关|求回關|互关|互關|follow(?:ed)?\s*(?:you|back)|follow\s*for\s*follow)/i.test(c.reply.text);
  function peak(seconds) {
    if (rows.length < 5) return null;
    let best = [];
    for (let left = 0, right = 0; right < rows.length; right++) {
      while (rows[right].reply.createdAt - rows[left].reply.createdAt > seconds * 1000) left++;
      if (right - left + 1 > best.length) best = rows.slice(left, right + 1);
    }
    return { count: best.length, distinctOriginals: new Set(best.map(c => c.root.id)).size,
      spanSeconds: (best.at(-1).reply.createdAt - best[0].reply.createdAt) / 1000,
      medianCharacters: median(best.map(c => length(c.reply.text))), mutualFollowShortReplies: best.filter(followOnly).length };
  }
  const samples = rows.map(c => ({ rootId: c.root.id, replyId: c.reply.id,
    authors: [c.root, ...c.ancestors].map(p => ({ handle: p.handle, userId: p.userId })) }));
  return { version: ACCOUNT_SIGNALS_VERSION, capturedAt: now, profile: profile || { displayName: null, bio: null, bioTruncated: false },
    activity: { coverage: "partial_complete_eligible_replies", count: rows.length, distinctOriginals: new Set(rows.map(c => c.root.id)).size,
      observedSpanSeconds: rows.length >= 2 ? (rows.at(-1).reply.createdAt - rows[0].reply.createdAt) / 1000 : null,
      medianGapSeconds: gaps.length >= 4 ? median(gaps) : null,
      gapsAtMost60Seconds: gaps.length >= 4 ? gaps.filter(n => n <= 60).length : null,
      gapCount: gaps.length, medianCharacters: median(rows.map(c => length(c.reply.text))),
      mutualFollowShortReplies: rows.filter(followOnly).length,
      repeatedTextCount: rows.length - new Set(rows.map(c => c.reply.text.trim().replace(/\s+/g, " "))).size,
      densest5Minutes: peak(300), densest15Minutes: peak(900), densest60Minutes: peak(3600),
      recurrentBatches: null, silenceConfirmed: false }, references: samples };
}

/** Model-safe view omits local scope IDs and absolute observation timestamps. Keeping
 * cache identity tied to facts rather than collection time allows identical reuse.
 */
export function accountSignalsForModel(signals) {
  return signals?.version === ACCOUNT_SIGNALS_VERSION ? { profile: signals.profile, activity: signals.activity }
    : { profile: { displayName: null, bio: null }, activity: null };
}
