/** User-authored filters. Matching is run only in the disposable regex worker. */
export function getFilterRules(settings = {}) {
  if (Array.isArray(settings.filterRules)) return settings.filterRules;
  return [
    { id: "BNB", revision: "preset-bnb-v1", name: "BNB", enabled: !!settings.nameBlockBNB, action: "block", mode: "all", conditions: [{ field: "name", op: "contains", value: "BNB", ignoreCase: true }] },
    { id: "AI", revision: "preset-ai-v2", name: "AI", enabled: !!settings.nameBlockAI, action: "block", mode: "all", conditions: [
      { field: "name", op: "regex", value: "\\p{Script=Han}", ignoreCase: true },
      { field: "name", op: "regex", value: "(?<![a-z])AI(?![a-z])", ignoreCase: true }
    ] }
  ];
}

/** Validate/clone rules without executing regex matches. Reject rather than truncate patterns. */
export function normalizeFilters(value) {
  if (!Array.isArray(value) || value.length > 50) throw new Error("rules: 0–50");
  const ids = new Set();
  return value.map(rule => {
    if (!rule || typeof rule.id !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(rule.id) || ids.has(rule.id)) throw new Error("rule ID");
    ids.add(rule.id);
    if (typeof rule.name !== "string" || !rule.name.trim() || rule.name.length > 80) throw new Error("rule name: 1–80");
    if (typeof rule.enabled !== "boolean" || !["block", "mask"].includes(rule.action) || !["all", "any"].includes(rule.mode)) throw new Error("rule action/mode");
    if (!Array.isArray(rule.conditions) || !rule.conditions.length || rule.conditions.length > 8) throw new Error("conditions: 1–8");
    return { id: rule.id, name: rule.name.trim(), enabled: rule.enabled, action: rule.action, mode: rule.mode,
      conditions: rule.conditions.map(c => {
        if (!c || !["name", "handle", "text", "blueVerified", "hasLink", "hasMedia"].includes(c.field)) throw new Error("condition field");
        const boolean = ["blueVerified", "hasLink", "hasMedia"].includes(c.field);
        if (boolean) {
          if (c.op !== "is" || typeof c.value !== "boolean") throw new Error("boolean condition");
          return { field: c.field, op: "is", value: c.value };
        }
        if (!["contains", "notContains", "equals", "regex"].includes(c.op) || typeof c.value !== "string" || !c.value.trim() || c.value.length > 512 || typeof c.ignoreCase !== "boolean") throw new Error("text condition: 1–512");
        if (c.op === "regex") new RegExp(c.value, c.ignoreCase ? "iu" : "u");
        return { field: c.field, op: c.op, value: c.value, ignoreCase: c.ignoreCase };
      }) };
  });
}

/** An immutable rule stamp binds a queued authorization to the exact rule that matched. */
export const filterStamp = rule => rule.revision || JSON.stringify(rule);

/** Read backend-issued grants, never run arbitrary patterns in the service worker.
 * Legacy jobs have no grants: only the two fixed migration predicates can authorize them.
 */
export function matchingNameRules(settings, target) {
  return getFilterRules(settings).filter(r => {
    if (!r.enabled || r.action !== "block") return false;
    if (target.filterGrants) return target.filterGrants[r.id] === filterStamp(r);
    const preset = getFilterRules({ nameBlockAI: true, nameBlockBNB: true }).find(p => p.id === r.id);
    if (!preset || JSON.stringify(normalizeFilters([preset])) !== JSON.stringify(normalizeFilters([r]))) return false;
    const name = String(target.name || "");
    return r.id === "BNB" ? /bnb/i.test(name) : /\p{Script=Han}/u.test(name) && /(?<![a-z])ai(?![a-z])/i.test(name);
  }).map(r => r.id);
}

/** Return match ranges for preview; incomplete/unknown fields never satisfy even a negative test. */
export function matchFilter(rule, target) {
  const details = rule.conditions.map(c => {
    if (c.field === "text" && target.incomplete || target[c.field] === null || target[c.field] === undefined) return { field: c.field, matched: false };
    if (c.op === "is") return { field: c.field, matched: target[c.field] === c.value };
    const text = String(target[c.field]);
    const a = c.ignoreCase ? text.toLowerCase() : text, b = c.ignoreCase ? c.value.toLowerCase() : c.value;
    if (c.op === "regex") {
      const match = new RegExp(c.value, c.ignoreCase ? "iu" : "u").exec(text);
      return { field: c.field, matched: !!match, range: match ? [match.index, match.index + match[0].length] : null };
    }
    const index = a.indexOf(b), matched = c.op === "equals" ? a === b : c.op === "notContains" ? index < 0 : index >= 0;
    return { field: c.field, matched, range: matched && c.op !== "notContains" ? [index, index + c.value.length] : null };
  });
  return { id: rule.id, matched: rule.mode === "all" ? details.every(c => c.matched) : details.some(c => c.matched), details };
}
