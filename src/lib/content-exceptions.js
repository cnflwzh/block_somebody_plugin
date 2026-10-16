// Local exceptions are scoped to the acting account and selected conversation.
// They never imply an X unblock or a permanent account-wide allowlist entry.
const TTL = 30 * 86400000;
export function contentExcepted(db, account, rootId, post, now = Date.now()) {
  if (!account || !rootId || !post) return false;
  return (db.contentExceptions || []).some(e => e.account === account && e.rootId === rootId && e.expires > now
    && (e.scope === "reply" ? e.replyId === post.id : e.userId && post.userId ? e.userId === post.userId : e.handle === post.handle));
}
/** Add/refresh a validated exception; keep at most 1000 non-expired entries. */
export function addContentException(db, account, rootId, post, scope, now = Date.now()) {
  if (!["reply", "thread-user"].includes(scope)) throw new Error("Invalid exception scope");
  const entry = { account, rootId, scope, replyId: post.id, userId: post.userId || "", handle: post.handle, expires: now + TTL };
  const key = e => `${e.account}:${e.rootId}:${e.scope}:${e.scope === "reply" ? e.replyId : e.userId || e.handle}`;
  db.contentExceptions = [...(db.contentExceptions || []).filter(e => e.expires > now && key(e) !== key(entry)), entry].slice(-1000);
  return entry;
}
