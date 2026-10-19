import { parseFilterFile, FILTER_FILE_LIMIT } from "./filter-transfer.js";

export const SUBSCRIPTION_INTERVAL = 24 * 60 * 60 * 1000;
/** HTTPS only. Credentials are never accepted in a URL or sent with requests. */
export function subscriptionUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("url");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("url");
  return url.href;
}
export const subscriptionOrigin = value => `${new URL(subscriptionUrl(value)).origin}/*`;

/** Bounded conditional fetch; redirects cannot silently expand host permission. */
export async function fetchSubscription(source, fetcher = fetch) {
  const url = subscriptionUrl(source.url), controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = { Accept: "application/json" };
    if (source.etag) headers["If-None-Match"] = source.etag;
    if (source.modified) headers["If-Modified-Since"] = source.modified;
    const response = await fetcher(url, { headers, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal: controller.signal });
    if (response.status === 304 && source.rules) return { unchanged: true };
    if (!response.ok || !response.body) throw new Error("fetch");
    if (Number(response.headers.get("content-length")) > FILTER_FILE_LIMIT) throw new Error("size");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let size = 0, text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > FILTER_FILE_LIMIT) throw new Error("size");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const remote = parseFilterFile(text, { preserveIds: true, allowEmpty: true });
    const rules = [];
    for (const rule of remote) {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rule.id));
      const suffix = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,"0")).join("").slice(0,24);
      rules.push({ ...rule, id: `s_${source.id.replaceAll("-", "")}_${suffix}` });
    }
    return { rules, etag: (response.headers.get("etag") || "").slice(0,1024), modified: (response.headers.get("last-modified") || "").slice(0,128) };
  } finally { clearTimeout(timeout); }
}

/** Install all sources atomically. Local rules remain untouched; changed rules
 * receive new grants so queued actions cannot rely on an older remote definition. */
export function installSubscriptions(db) {
  const rules = (db.filterSubscriptions || []).flatMap(source => source.rules || []);
  if (rules.length + (db.settings.filterRules || []).length > 50) throw new Error("limit");
  const previous = new Map((db.settings.subscriptionRules || []).map(rule => [rule.id, rule]));
  db.settings.subscriptionRules = rules.map(rule => {
    const before = previous.get(rule.id), { revision: ignored, ...old } = before || {};
    return { ...rule, revision: before && JSON.stringify(old) === JSON.stringify(rule) ? before.revision : crypto.randomUUID() };
  });
}

/** Worker-owned service. Callers supply serialized storage and revocation hooks.
 * Preview tokens expire and are never accepted from a webpage content script. */
export function createSubscriptionService({ read, change, changed, revoke, fetcher = fetch }) {
  const previews = new Map(), flights = new Map();
  const permitted = async url => {
    if (!await chrome.permissions.contains({ origins: [subscriptionOrigin(url)] })) throw new Error("permission");
  };
  async function refresh(id, automatic = false) {
    if (flights.has(id)) return flights.get(id);
    const work = (async () => {
      const source = await change(db => {
        const item = db.filterSubscriptions?.find(s => s.id === id); if (!item) throw new Error("missing");
        if (automatic && !item.autoUpdate) return null;
        item.lastAttempt = Date.now(); return { ...item };
      });
      if (!source) return true;
      try {
        await permitted(source.url);
        const result = await fetchSubscription(source, fetcher);
        await change(db => {
          const current = db.filterSubscriptions?.find(s => s.id === id);
          if (!current || current.revision !== source.revision) return;
          if (!result.unchanged) Object.assign(current, result);
          current.lastCheck = Date.now(); current.error = "";
          installSubscriptions(db); revoke(db);
        });
        changed(); return true;
      } catch (error) {
        await change(db => {
          const current = db.filterSubscriptions?.find(s => s.id === id);
          if (current?.revision === source.revision) current.error = error.message === "limit" ? "limit" : "update";
        });
        changed(); throw new Error("update");
      }
    })();
    flights.set(id, work);
    try { return await work; } finally { flights.delete(id); }
  }
  return {
    async preview(value) {
      const url = subscriptionUrl(value); await permitted(url);
      for (const [key, entry] of previews) if (entry.expires < Date.now()) previews.delete(key);
      if (previews.size >= 10) previews.delete(previews.keys().next().value);
      const source = { id: crypto.randomUUID(), url };
      const result = await fetchSubscription(source, fetcher), token = crypto.randomUUID();
      previews.set(token, { source: { ...source, ...result }, expires: Date.now() + 600000 });
      return { token, rules: result.rules.map(({ name, action }) => ({ name, action })) };
    },
    async add(token, autoUpdate) {
      const entry = previews.get(token);
      if (!entry || entry.expires < Date.now()) throw new Error("expired");
      await change(db => {
        db.filterSubscriptions ||= [];
        if (db.filterSubscriptions.length >= 10 || db.filterSubscriptions.some(s => s.url === entry.source.url)) throw new Error("duplicate");
        db.filterSubscriptions.push({ ...entry.source, autoUpdate: autoUpdate === true, revision: 1, lastAttempt: Date.now(), lastCheck: Date.now(), error: "" });
        installSubscriptions(db); revoke(db);
      });
      previews.delete(token); changed(); return true;
    },
    refresh,
    async edit(id, autoUpdate, remove = false) {
      await change(db => {
        const item = db.filterSubscriptions?.find(s => s.id === id); if (!item) throw new Error("missing");
        if (remove) db.filterSubscriptions = db.filterSubscriptions.filter(s => s.id !== id);
        else { item.autoUpdate = autoUpdate === true; item.revision++; }
        installSubscriptions(db); revoke(db);
      }); changed(); return true;
    },
    async due() {
      const ids = await read(db => (db.filterSubscriptions || []).filter(s => s.autoUpdate && Date.now() - (s.lastAttempt || 0) >= SUBSCRIPTION_INTERVAL).map(s => s.id));
      for (const id of ids) await refresh(id, true).catch(() => {});
    }
  };
}
