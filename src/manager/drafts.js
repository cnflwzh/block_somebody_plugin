const KEY = "blocksb.settings-drafts.v1";
const GROUPS = Object.freeze({
  general: ["block-hidden-text", "language", "cache-limit", "reduced-motion", "animation-effect"],
  support: ["preset", "high", "confidence", "skip-following", "mask-enabled", "maskThreshold", "auto-load-default"],
  observer: ["observer-enabled", "observer-scope", "observer-preset", "observer-threshold", "observer-confidence", "observer-minHits", "observer-hit-policy", "observer-skipFollowing", "observer-showMarkers", "observer-mask", "observer-mode", "observer-reviewMinReplies", "observer-reviewThreshold", "observer-reviewConfidence"]
});
/** Return only explicitly allowed UI draft fields; model credentials/configuration are never accepted. */
export function sanitizeDrafts(value) {
  const result = {};
  for (const [group, fields] of Object.entries(GROUPS)) {
    if (!value?.[group] || typeof value[group] !== "object") continue;
    const clean = {};
    for (const key of fields) {
      const entry = value[group][key];
      if (typeof entry === "boolean" || typeof entry === "string" && entry.length <= 100) clean[key] = entry;
    }
    // Older drafts stored only the count; derive its new selector without losing that draft.
    if (group === "observer" && clean["observer-minHits"] !== undefined && clean["observer-hit-policy"] === undefined) {
      clean["observer-hit-policy"] = ["1", "2"].includes(clean["observer-minHits"]) ? clean["observer-minHits"] : "custom";
    }
    if (Object.keys(clean).length) result[group] = clean;
  }
  return result;
}
/** Create extension-local draft storage. Reads/writes are synchronous so closing a popup loses no pending timer. */
export function createSettingsDrafts(storage = localStorage) {
  let drafts = {};
  try { drafts = sanitizeDrafts(JSON.parse(storage.getItem(KEY) || "{}")); } catch { /* Invalid or unavailable storage starts empty. */ }
  const persist = () => { try { storage.setItem(KEY, JSON.stringify(sanitizeDrafts(drafts))); return true; } catch { return false; } };
  return {
    capture(group, form) {
      const value = {};
      for (const key of GROUPS[group] || []) {
        const field = form.querySelector(`[id="${key}"]`) || form.querySelector(`[name="${key}"]:checked`);
        if (field) value[key] = field.type === "checkbox" ? field.checked : field.value;
      }
      drafts[group] = value;
      return persist();
    },
    restore(group, form) {
      const value = drafts[group]; if (!value) return false;
      for (const key of GROUPS[group] || []) {
        if (!(key in value)) continue;
        const field = form.querySelector(`[id="${key}"]`);
        if (field) { if (field.type === "checkbox") field.checked = value[key] === true; else field.value = String(value[key]); }
        else {
          const radios = [...form.querySelectorAll(`[name="${key}"]`)];
          if (radios.some(radio => radio.value === value[key])) for (const radio of radios) radio.checked = radio.value === value[key];
        }
      }
      return true;
    },
    clear(group) { delete drafts[group]; return persist(); }
  };
}
