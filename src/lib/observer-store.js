import "./i18n.js";
const { t } = globalThis.BlockSBI18n;
// Separate from request cache: deleting a model cache must never count a reply twice.
let opening;
let retainedRows;
function open() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open("blocksb-observer", 1);
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error(t("observer_error_database_timeout"))); }, 3000);
    request.onupgradeneeded = () => {
      const evidence = request.result.createObjectStore("evidence", { keyPath: "key" });
      evidence.createIndex("user", "userKey"); evidence.createIndex("reply", "replyKey"); evidence.createIndex("time", "observedAt");
      request.result.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => { clearTimeout(timer); if (expired) return request.result.close(); const db = request.result; db.onversionchange = () => { db.close(); opening = null; retainedRows = null; }; resolve(db); };
    request.onerror = request.onblocked = () => { clearTimeout(timer); expired = true; reject(request.error || new Error(t("observer_error_database_unavailable"))); };
  }).catch(error => { opening = null; throw error; });
  return opening;
}
async function transaction(mode, work) {
  const db = await open();
  if (mode === "readwrite") retainedRows = null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["evidence", "meta"], mode); let result;
    tx.oncomplete = () => { if (mode === "readwrite") retainedRows = null; resolve(result); };
    tx.onerror = tx.onabort = () => { if (mode === "readwrite") retainedRows = null; reject(tx.error || new Error(t("observer_error_database_transaction"))); };
    try { work(tx.objectStore("evidence"), tx.objectStore("meta"), value => { result = value; }); } catch (error) { tx.abort(); reject(error); }
  });
}
/** Build an account-scoped stable-user key from validated string identities. */
export const observerUserKey = (account, userId) => `${account}:${userId}`;
/** Build the unique reply/rule key; re-reading a reply must not add another observation. */
export const observerEvidenceKey = (account, replyId, fingerprint) => `${account}:${replyId}:${fingerprint}`;
/** Durable normal-account decisions are separate from expiring evidence/model caches.
 * Stable IDs prevent renamed/reassigned handles from transferring this exemption.
 */
export function readNormalAccount(account, userId) { return transaction("readonly", (store, meta, done) => {
  const r = meta.get(`normal:${observerUserKey(account, userId)}`); r.onsuccess = () => done(r.result || null);
}); }
export function saveNormalAccount(account, target, epoch) { return transaction("readwrite", (store, meta, done) => {
  const guard = meta.get(`epoch:${observerUserKey(account, target.userId)}`); guard.onsuccess = () => {
    if ((guard.result?.value || 0) !== epoch) return done(false);
    meta.put({ key: `normal:${observerUserKey(account, target.userId)}`, account, userId: target.userId, handle: target.handle, name: target.name || target.handle, at: Date.now() }); done(true);
  };
}); }
export function listNormalAccounts() { return transaction("readonly", (store, meta, done) => {
  const r = meta.getAll(IDBKeyRange.bound("normal:", "normal:\uffff")); r.onsuccess = () => done(r.result);
}); }
/** Explicit removal invalidates old combined verdicts so they cannot refill the list. */
export function removeNormalAccount(account, userId) { return transaction("readwrite", (store, meta) => {
  const userKey = observerUserKey(account, userId);
  meta.delete(`normal:${userKey}`); meta.delete(`review:${userKey}`); meta.delete(`collection:${userKey}`);
  const guard = meta.get(`epoch:${userKey}`); guard.onsuccess = () => meta.put({ key: `epoch:${userKey}`, value: (guard.result?.value || 0) + 1 });
  const r = store.index("user").openCursor(userKey); r.onsuccess = () => { const c = r.result; if (c) {
    if (c.value.collected) c.delete(); // Retain cumulative-mode judgments and block history.
    c.continue();
  } };
}); }
/** Read one persisted record or undefined. Callers apply the current retention policy. */
export function readObserverEvidence(key) { return transaction("readonly", (store, meta, done) => { const r = store.get(key); r.onsuccess = () => done(r.result); }); }
/** Return this acting account's observations of one stable user, including withdrawn rows. */
export function readObserverUser(account, userId) { return transaction("readonly", (store, meta, done) => { const r = store.index("user").getAll(observerUserKey(account, userId)); r.onsuccess = () => done(r.result); }); }
/** Return all retained records for the trusted management panel; never expose this to a page. */
export function readObserverAll() {
  // Read-only consumers group rows without mutating them. Share concurrent full reads;
  // every write invalidates the cache at both transaction boundaries.
  if (!retainedRows) {
    const current = transaction("readonly", (store, meta, done) => { const r = store.getAll(); r.onsuccess = () => done(Object.freeze(r.result.map(Object.freeze))); });
    retainedRows = current;
    current.catch(() => { if (retainedRows === current) retainedRows = null; });
  }
  return retainedRows;
}
/** Indexed batch lookup returns all rule versions; the caller filters the current fingerprint. */
export function readObserverReplies(account, replyIds) { return transaction("readonly", (store, meta, done) => {
  const result = []; done(result);
  for (const replyId of new Set(replyIds)) { const r = store.index("reply").getAll(`${account}:${replyId}`); r.onsuccess = () => result.push(...r.result); }
}); }
/** Return the monotonic withdrawal generation used to reject late asynchronous results. */
export function observerEpoch(account, userId) { return transaction("readonly", (store, meta, done) => { const r = meta.get(`epoch:${observerUserKey(account, userId)}`); r.onsuccess = () => done(r.result?.value || 0); }); }
/** Atomically insert one reply under the captured epoch; resolves false for duplicates or
 * invalidated flights. Expired entries may be replaced after retentionDays since observation.
 */
export function saveObserverEvidence(entry, epoch, retentionDays = 30) { return transaction("readwrite", (store, meta, done) => {
  const guard = meta.get(`epoch:${entry.userKey}`);
  guard.onsuccess = () => {
    if ((guard.result?.value || 0) !== epoch) return done(false);
    const r = store.get(entry.key);
    r.onsuccess = () => {
      if (r.result && r.result.observedAt > Date.now() - retentionDays * 86400000) return done(false);
      store.put(entry); done(true);
      // Review needs only ten recent contexts per user, not the full retained history.
      if (entry.reviewContext) { const recent = store.index("user").getAll(entry.userKey); recent.onsuccess = () => {
        const texts = recent.result.filter(e => e.reviewContext).sort((a, b) => b.observedAt - a.observedAt);
        for (const old of texts.slice(10)) { const { reviewContext, ...score } = old; store.put(score); }
      }; }
    };
  };
}); }
/** A threshold edit re-evaluates evidence without changing its age or counting it again. */
export function markObserverEvaluated(key, epoch, policyRevision) { return transaction("readwrite", (store, meta) => {
  const r = store.get(key);
  r.onsuccess = () => {
    const entry = r.result; if (!entry || entry.withdrawn) return;
    const guard = meta.get(`epoch:${entry.userKey}`);
    guard.onsuccess = () => { if ((guard.result?.value || 0) === epoch) store.put({ ...entry, policyRevision }); };
  };
}); }
/** Reserve at most one review per user/hour and require a changed sample set after a prior
 * attempt. Reservation persists across worker restarts; failed requests are not retried
 * merely because a page refreshes. Epochs invalidate work after undo/forget.
 */
export function reserveAccountReview(userKey, epoch, fingerprint, replyIds, now = Date.now()) { return transaction("readwrite", (store, meta, done) => {
  const guard = meta.get(`epoch:${userKey}`);
  guard.onsuccess = () => {
    if ((guard.result?.value || 0) !== epoch) return done(false);
    const key = `review:${userKey}`, r = meta.get(key);
    r.onsuccess = () => {
      const old = r.result;
      if (old && (now - old.at < 3600000 || old.fingerprint === fingerprint && old.epoch === epoch && replyIds.every(id => old.replyIds.includes(id)))) return done(false);
      meta.put({ key, at: now, epoch, fingerprint, replyIds }); done(true);
    };
  };
}); }
/** Attach a validated aggregate result without changing the single-reply classification. */
export function saveAccountReview(key, epoch, accountReview) { return transaction("readwrite", (store, meta, done) => {
  const r = store.get(key); r.onsuccess = () => {
    const e = r.result; if (!e || e.withdrawn) return done(false);
    const guard = meta.get(`epoch:${e.userKey}`); guard.onsuccess = () => {
      if ((guard.result?.value || 0) !== epoch) return done(false);
      store.put({ ...e, accountReview }); done(true);
    };
  };
}); }
/** Disabling optional review removes its retained text and results, leaving normal scores. */
export function clearAccountReviewData() { return transaction("readwrite", (store, meta) => {
  const collections = meta.openCursor(IDBKeyRange.bound("collection:", "collection:\uffff"));
  collections.onsuccess = () => { const c = collections.result; if (c) { const { accountSignals, ...entry } = c.value; c.update(entry); c.continue(); } };
  const users = new Set();
  const r = store.openCursor(); r.onsuccess = () => { const c = r.result; if (!c) return;
    if (c.value.reviewContext || c.value.accountReview) {
      const { reviewContext, accountReview, ...entry } = c.value;
      if (entry.collected) entry.withdrawn = true;
      c.update(entry);
      if (!users.has(entry.userKey)) { users.add(entry.userKey); const key = `epoch:${entry.userKey}`, guard = meta.get(key);
        guard.onsuccess = () => meta.put({ key, value: (guard.result?.value || 0) + 1 });
      }
    } c.continue();
  };
}); }
/** Keep withdrawn reply identities until normal expiry so refresh cannot resurrect evidence. */
export function forgetObserverUser(account, userId) { return transaction("readwrite", (store, meta) => {
  const userKey = observerUserKey(account, userId), r = meta.get(`epoch:${userKey}`);
  r.onsuccess = () => meta.put({ key: `epoch:${userKey}`, value: (r.result?.value || 0) + 1 });
  const collection = meta.get(`collection:${userKey}`); collection.onsuccess = () => { if (collection.result) { const { accountSignals, ...entry } = collection.result; meta.put(entry); } };
  const entries = store.index("user").openCursor(userKey);
  entries.onsuccess = () => { const c = entries.result; if (c) {
    const { reviewContext, accountReview, ...entry } = c.value;
    c.update({ ...entry, withdrawn: true }); c.continue();
  } };
}); }
/** Count transmissions per UTC day; no limit by default. An explicit limit is optional.
 * Reserve before sending because a failed request may still consume model usage.
 */
export function reserveObserverBudget(limit = Infinity, now = Date.now()) { return transaction("readwrite", (store, meta, done) => {
  const day = new Date(now).toISOString().slice(0, 10), r = meta.get("budget");
  r.onsuccess = () => { const used = r.result?.day === day ? r.result.used : 0; if (used >= limit) return done(false); meta.put({ key: "budget", day, used: used + 1 }); done(true); };
}); }
/** Return the number of reserved transmissions for the UTC day containing now (milliseconds). */
export function readObserverBudget(now = Date.now()) { return transaction("readonly", (store, meta, done) => { const r = meta.get("budget"); r.onsuccess = () => done(r.result?.day === new Date(now).toISOString().slice(0, 10) ? r.result.used : 0); }); }

/** Reserve an account collection before any HTTP request. Persistent cooldown prevents
 * refresh/restart storms; withdrawal epochs prevent a cancelled collection from winning.
 */
export function reserveReplyCollection(userKey, epoch, now = Date.now()) { return transaction("readwrite", (store, meta, done) => {
  const guard = meta.get(`epoch:${userKey}`); guard.onsuccess = () => {
    if ((guard.result?.value || 0) !== epoch) return done(false);
    const key = `collection:${userKey}`, r = meta.get(key); r.onsuccess = () => {
      if (r.result?.retryAt > now) return done(false);
      meta.put({ key, userKey, epoch, at: now, retryAt: now + 3600000, status: "fetching" }); done(true);
    };
  };
}); }
/** Publish only a small status, never raw API errors, headers or response bodies. */
export function finishReplyCollection(userKey, epoch, status, retryAt = Date.now() + 3600000, accountSignals = null) { return transaction("readwrite", (store, meta) => {
  const key = `collection:${userKey}`, guard = meta.get(`epoch:${userKey}`); guard.onsuccess = () => {
    if ((guard.result?.value || 0) !== epoch) return;
    const r = meta.get(key); r.onsuccess = () => { if (r.result?.epoch === epoch) meta.put({ ...r.result, status, retryAt: Math.max(Date.now(), retryAt), accountSignals }); };
  };
}); }
/** Read facts from this acting account's latest bounded collection; caller checks epoch,
 * current rules, retention and protected source contexts before using the summary.
 */
export function readReplyCollection(userKey) { return transaction("readonly", (store, meta, done) => {
  const r = meta.get(`collection:${userKey}`); r.onsuccess = () => done(r.result || null);
}); }
/** Read account collection status for the trusted management panel only. */
export function readReplyCollections() { return transaction("readonly", (store, meta, done) => {
  const result = new Map(); done(result); const r = meta.openCursor(IDBKeyRange.bound("collection:", "collection:\uffff"));
  r.onsuccess = () => { const c = r.result; if (c) { result.set(c.value.userKey, c.value); c.continue(); } };
}); }
/** Global serial reads: >=3 seconds apart and <=200 pages per login per UTC day.
 * Returns a persisted retry deadline when blocked, so worker restarts cannot bypass it.
 */
export function reserveReplyPage(actorId, now = Date.now()) { return transaction("readwrite", (store, meta, done) => {
  const key = `reply-network:${actorId}`, r = meta.get(key); r.onsuccess = () => {
    const old = r.result || {}, day = new Date(now).toISOString().slice(0, 10), used = old.day === day ? old.used : 0;
    const retryAt = Math.max(old.nextAt || 0, old.pauseUntil || 0, used >= 200 ? Date.parse(`${day}T00:00:00Z`) + 86400000 : 0);
    if (retryAt > now) return done({ allowed: false, retryAt });
    meta.put({ ...old, key, day, used: used + 1, nextAt: now + 3000 }); done({ allowed: true });
  };
}); }
/** Respect server rate/auth/endpoint failures across all targets for this login. */
export function pauseReplyPages(actorId, until) { return transaction("readwrite", (store, meta) => {
  const key = `reply-network:${actorId}`, r = meta.get(key); r.onsuccess = () => meta.put({ ...r.result, key, pauseUntil: Math.max(r.result?.pauseUntil || 0, until) });
}); }
/** Expire by original observation time, then remove oldest rows beyond limit; resolves void.
 * Reads never extend lifetime. Withdrawal generations outlive evidence to guard late flights.
 */
export function cleanObserverEvidence(days = 30, limit = 10000) { return transaction("readwrite", (store, meta) => {
  const reviews = meta.openCursor(); reviews.onsuccess = () => { const c = reviews.result; if (!c) return;
    if ((c.key.startsWith("review:") || c.key.startsWith("collection:")) && c.value.at < Date.now() - days * 86400000) c.delete(); c.continue();
  };
  const r = store.index("time").openCursor(IDBKeyRange.upperBound(Date.now() - days * 86400000));
  r.onsuccess = () => {
    const c = r.result; if (c) { c.delete(); c.continue(); return; }
    const count = store.count(); count.onsuccess = () => { let extra = count.result - limit; if (extra <= 0) return; const old = store.index("time").openCursor(); old.onsuccess = () => { const c = old.result; if (c && extra-- > 0) { c.delete(); c.continue(); } }; };
  };
}); }
