import "./i18n.js";
const { t } = globalThis.BlockSBI18n;
import { sanitizePost } from "./core.js";

const TTL = 30 * 86400000, LIMIT = 3000;
let database;

/** Merge observations of one post without letting a tombstone or truncated card erase context.
 * IDs and authors must match; this never infers a parent from visual adjacency.
 */
export function mergeContextPost(previous, post) {
  if (!previous || previous.id !== post.id || previous.handle !== post.handle) return post;
  const keepText = previous.text && (!post.text || !previous.incomplete && post.incomplete);
  return { ...post, userId: post.userId || previous.userId, conversationId: post.conversationId || previous.conversationId,
    parentId: post.parentId || previous.parentId, text: keepText ? previous.text : post.text,
    incomplete: keepText ? previous.incomplete : post.incomplete, hasMedia: post.hasMedia || previous.hasMedia };
}

function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("blocksb-thread-context", 1);
    let abandoned = false;
    const fail = error => { abandoned = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => fail(new Error(t("ui_reply_context_cache_open_timed_out"))), 3000);
    request.onblocked = () => fail(new Error(t("ui_reply_context_cache_is_in_use")));
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("posts", { keyPath: "key" });
      store.createIndex("updated", "updated");
    };
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      const db = request.result; clearTimeout(timer);
      if (abandoned) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = null; };
      resolve(db);
    };
  }).catch(error => { database = null; throw error; });
  return database;
}

/** Save observed posts and retrieve missing parents, isolated by acting account and selected root.
 * Text stays in this extension-local database (not the Jev result cache or exports).
 * Resolves after the transaction commits; rejects on storage failure. No network requests.
 */
export async function syncThreadContext(account, rootId, posts, missingIds) {
  const db = await openDatabase(), now = Date.now();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("posts", "readwrite"), store = tx.objectStore("posts"), results = [];
    const key = postId => [account, rootId, postId];
    tx.oncomplete = () => resolve(results);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error(t("ui_could_not_save_reply_context")));
    for (const value of posts) {
      const post = sanitizePost(value), read = store.get(key(post.id));
      read.onsuccess = () => {
        const previous = read.result?.updated > now - TTL ? read.result.post : null;
        const merged = mergeContextPost(previous, post);
        store.put({ key: key(post.id), post: merged, updated: now }); results.push(merged);
      };
    }
    for (const postId of missingIds) {
      const read = store.get(key(postId));
      read.onsuccess = () => { if (read.result?.updated > now - TTL) results.push(read.result.post); };
    }
    // Prune after all queued writes, keeping this independent of chrome.storage's state quota.
    const fence = store.get(["", "", ""]);
    fence.onsuccess = () => {
      const expired = store.index("updated").openCursor(IDBKeyRange.upperBound(now - TTL));
      expired.onsuccess = () => {
        const cursor = expired.result;
        if (cursor) { cursor.delete(); cursor.continue(); return; }
        const count = store.count();
        count.onsuccess = () => {
          let excess = count.result - LIMIT;
          if (excess <= 0) return;
          const oldest = store.index("updated").openCursor();
          oldest.onsuccess = () => { const entry = oldest.result; if (entry && excess-- > 0) { entry.delete(); entry.continue(); } };
        };
      };
    };
  });
}
