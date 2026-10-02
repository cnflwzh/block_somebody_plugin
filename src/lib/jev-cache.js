import "./i18n.js";
const { t } = globalThis.BlockSBI18n;
import { askJev } from "./jev.js";
import { JEV_CACHE_TTL, DEFAULT_ENDPOINT, normalizeEndpoint } from "./core.js";

export const CACHE_TTL = JEV_CACHE_TTL;
const flights = new Map();
let database;

// Keep up to 10000 compact answers outside chrome.storage's shared state/quota.
// Neither tweet text nor credentials are persisted here: the key is a request digest.
function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("blocksb-jev-cache", 1);
    let abandoned = false;
    const fail = error => { abandoned = true; clearTimeout(timer); reject(error); };
    // A blocked upgrade/open must not hold every model request indefinitely.
    const timer = setTimeout(() => fail(new Error(t("ui_cache_open_timed_out"))), 3000);
    request.onblocked = () => fail(new Error(t("ui_cache_is_in_use_by_another_window")));
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("answers", { keyPath: "key" });
      store.createIndex("expiresAt", "expiresAt");
      store.createIndex("usedAt", "usedAt");
    };
    request.onsuccess = () => {
      const db = request.result;
      clearTimeout(timer);
      if (abandoned) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = null; };
      resolve(db);
    };
    request.onerror = () => fail(request.error);
  }).catch(error => { database = null; throw error; });
  return database;
}

async function transaction(work) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("answers", "readwrite");
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error(t("ui_cache_transaction_failed")));
    try { work(tx.objectStore("answers"), value => { result = value; }); }
    catch (error) { tx.abort(); reject(error); }
  });
}

function prune(store, limit, now) {
  const expired = store.index("expiresAt").openCursor(IDBKeyRange.upperBound(now));
  expired.onsuccess = () => {
    const cursor = expired.result;
    if (cursor) { cursor.delete(); cursor.continue(); return; }
    const count = store.count();
    count.onsuccess = () => {
      let excess = count.result - limit;
      if (excess <= 0) return;
      const oldest = store.index("usedAt").openCursor();
      oldest.onsuccess = () => {
        const entry = oldest.result;
        if (entry && excess-- > 0) { entry.delete(); entry.continue(); }
      };
    };
  };
}

/** Expire answers 30 days after creation (hits do not extend TTL), then evict least-used entries. */
export async function cleanJevCache(limit = 10000) {
  return transaction(store => prune(store, limit, Date.now()));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** Hash all model, instruction and context fields, so edits or prompt changes cannot hit an old answer. */
export async function requestKey(request, endpoint = DEFAULT_ENDPOINT) {
  endpoint = normalizeEndpoint(endpoint);
  // Preserve existing official-endpoint cache keys; isolate every other endpoint.
  const value = endpoint === DEFAULT_ENDPOINT ? request : { endpoint, request };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value))));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function lookup(key) {
  return transaction((store, done) => {
    const request = store.get(key);
    request.onsuccess = () => {
      const entry = request.result;
      if (!entry) return;
      if (entry.expiresAt <= Date.now()) { store.delete(key); return; }
      entry.usedAt = Date.now(); store.put(entry); done(entry.payload);
    };
  });
}

const cancelled = () => new Error(t("ui_analysis_canceled"));

/** Return a validated answer, reusing persistent results and concurrent identical requests.
 * validate(payload) must throw on malformed output. Actions/thresholds are never cached.
 * Each caller can cancel independently; abort the HTTP request only when no callers remain.
 */
export async function askJevCached(request, apiKey, signal, validate, limit = 10000, endpoint = DEFAULT_ENDPOINT) {
  if (signal?.aborted) throw cancelled();
  const key = await requestKey(request, endpoint);
  if (signal?.aborted) throw cancelled();
  let flight = flights.get(key);
  if (!flight) {
    flight = { controller: new AbortController(), users: 0, settled: false };
    const current = flight;
    current.promise = Promise.resolve().then(async () => {
      let cached;
      try { cached = await lookup(key); } catch { console.warn(t("ui_block_s_b_cache_read_failed_using_online_analysis")); }
      if (current.controller.signal.aborted) throw cancelled();
      if (cached) {
        try { validate(cached); return cached; }
        catch {
          // An obsolete/corrupt entry should not fail every future attempt for 30 days.
          await transaction(store => store.delete(key)).catch(() => {});
        }
      }
      if (current.controller.signal.aborted) throw cancelled();
      const response = await askJev(request, apiKey, current.controller.signal, endpoint);
      if (current.controller.signal.aborted) throw cancelled();
      validate(response);
      const now = Date.now();
      // Store only the validated choice fields. Providers may attach large diagnostics or echoed input.
      const stance = response.answers.stance;
      const payload = { model: String(response.model || request.model).slice(0, 100), answers: { stance: {
        type: "choice", choice: stance.choice, confidence: stance.confidence,
        probabilities: Object.fromEntries(Object.keys(request.questions.stance.criteria).map(label => [label, stance.probabilities[label]]))
      } }, cacheCreatedAt: now };
      try {
        await transaction(store => {
          store.put({ key, payload, createdAt: now, expiresAt: now + CACHE_TTL, usedAt: now });
          prune(store, limit, now);
        });
      } catch { console.warn(t("ui_block_s_b_cache_write_failed_this_result_is_still")); }
      return payload;
    }).finally(() => {
      current.settled = true;
      if (flights.get(key) === current) flights.delete(key);
    });
    flights.set(key, current);
  }
  flight.users++;
  let onAbort;
  try {
    const payload = await (signal ? Promise.race([flight.promise, new Promise((_, reject) => {
      onAbort = () => reject(cancelled());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]) : flight.promise);
    validate(payload);
    return payload;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (--flight.users === 0 && !flight.settled) {
      flight.controller.abort();
      if (flights.get(key) === flight) flights.delete(key);
    }
  }
}
