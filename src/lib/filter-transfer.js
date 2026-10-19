import { normalizeFilters } from "./filter-rules.js";

export const FILTER_FILE_LIMIT = 1024 * 1024;
/** Read a versioned bundle, a rule array or one rule. Validation never executes
 * a regex match. New IDs prevent imported rules inheriting old queue grants. */
export function parseFilterFile(text, { preserveIds = false, allowEmpty = false } = {}) {
  const value = JSON.parse(text.replace(/^\uFEFF/, ""));
  let rows;
  if (Array.isArray(value)) rows = value;
  else if (value?.format === "block-sb-filters") {
    if (value.version !== 1 || !Array.isArray(value.rules)) throw new Error("format");
    rows = value.rules;
  } else if (value && typeof value === "object" && Array.isArray(value.conditions)) rows = [value];
  else throw new Error("format");
  if ((!rows.length && !allowEmpty) || rows.length > 50) throw new Error("count");
  return normalizeFilters(rows.map((row, index) => ({ ...row, id: preserveIds ? row?.id || `row-${index}` : crypto.randomUUID() })));
}

/** Export only rule configuration; never include history, credentials or grants. */
export function exportFilterFile(rules) {
  if (!rules.length) throw new Error("count");
  return JSON.stringify({ format: "block-sb-filters", version: 1, rules: normalizeFilters(rules) }, null, 2);
}
