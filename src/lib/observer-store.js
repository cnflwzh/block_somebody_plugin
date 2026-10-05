import "./i18n.js";
const { t } = globalThis.BlockSBI18n;
// Separate from request cache: deleting a model cache must never count a reply twice.
let opening;
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
    request.onsuccess = () => { clearTimeout(timer); if (expired) return request.result.close(); const db = request.result; db.onversionchange = () => { db.close(); opening = null; }; resolve(db); };
    request.onerror = request.onblocked = () => { clearTimeout(timer); expired = true; reject(request.error || new Error(t("observer_error_database_unavailable"))); };
  }).catch(error => { opening = null; throw error; });
  return opening;
}
async function transaction(mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["evidence", "meta"], mode); let result;
    tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(tx.error || new Error(t("observer_error_database_transaction")));
    try { work(tx.objectStore("evidence"), tx.objectStore("meta"), value => { result = value; }); } catch (error) { tx.abort(); reject(error); }
  });
}
/** Build an account-scoped stable-user key from validated string identities. */
export const observerUserKey = (account, userId) => `${account}:${userId}`;
/** Build the unique reply/rule key; re-reading a reply must not add another observation. */
export const observerEvidenceKey = (account, replyId, fingerprint) => `${account}:${replyId}:${fingerprint}`;
/** Read one persisted record or undefined. Callers apply the current retention policy. */
export function readObserverEvidence(key) { return transaction("readonly", (store, meta, done) => { const r = store.get(key); r.onsuccess = () => done(r.result); }); }
/** Return this acting account's observations of one stable user, including withdrawn rows. */
export function readObserverUser(account, userId) { return transaction("readonly", (store, meta, done) => { const r = store.index("user").getAll(observerUserKey(account, userId)); r.onsuccess = () => done(r.result); }); }
/** Return all retained records for the trusted management panel; never expose this to a page. */
export function readObserverAll() { return transaction("readonly", (store, meta, done) => { const r = store.getAll(); r.onsuccess = () => done(r.result); }); }
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
    r.onsuccess = () => { if (r.result && r.result.observedAt > Date.now() - retentionDays * 86400000) return done(false); store.put(entry); done(true); };
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
/** Keep withdrawn reply identities until normal expiry so refresh cannot resurrect evidence. */
export function forgetObserverUser(account, userId) { return transaction("readwrite", (store, meta) => {
  const userKey = observerUserKey(account, userId), r = meta.get(`epoch:${userKey}`);
  r.onsuccess = () => meta.put({ key: `epoch:${userKey}`, value: (r.result?.value || 0) + 1 });
  const entries = store.index("user").openCursor(userKey);
  entries.onsuccess = () => { const c = entries.result; if (c) { c.update({ ...c.value, withdrawn: true }); c.continue(); } };
}); }
/** Budget is a persistent UTC-day global cap. Reserve before transmission; failures still cost. */
export function reserveObserverBudget(limit, now = Date.now()) { return transaction("readwrite", (store, meta, done) => {
  const day = new Date(now).toISOString().slice(0, 10), r = meta.get("budget");
  r.onsuccess = () => { const used = r.result?.day === day ? r.result.used : 0; if (used >= limit) return done(false); meta.put({ key: "budget", day, used: used + 1 }); done(true); };
}); }
/** Return the number of reserved transmissions for the UTC day containing now (milliseconds). */
export function readObserverBudget(now = Date.now()) { return transaction("readonly", (store, meta, done) => { const r = meta.get("budget"); r.onsuccess = () => done(r.result?.day === new Date(now).toISOString().slice(0, 10) ? r.result.used : 0); }); }
/** Expire by original observation time, then remove oldest rows beyond limit; resolves void.
 * Reads never extend lifetime. Withdrawal generations outlive evidence to guard late flights.
 */
export function cleanObserverEvidence(days = 30, limit = 10000) { return transaction("readwrite", (store, meta) => {
  const r = store.index("time").openCursor(IDBKeyRange.upperBound(Date.now() - days * 86400000));
  r.onsuccess = () => {
    const c = r.result; if (c) { c.delete(); c.continue(); return; }
    const count = store.count(); count.onsuccess = () => { let extra = count.result - limit; if (extra <= 0) return; const old = store.index("time").openCursor(); old.onsuccess = () => { const c = old.result; if (c && extra-- > 0) { c.delete(); c.continue(); } }; };
  };
}); }
