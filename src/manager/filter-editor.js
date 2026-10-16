import { getFilterRules, normalizeFilters } from "../lib/filter-rules.js";
const { t } = globalThis.BlockSBI18n;
const fields = ["name", "handle", "text", "blueVerified", "hasLink", "hasMedia"];
const booleanField = field => ["blueVerified", "hasLink", "hasMedia"].includes(field);
const filterLabel = value => value === "mask" ? "ui_filter_hide_action" : `ui_filter_${value.replace(/[A-Z]/g, c => "_" + c.toLowerCase())}`;
const node = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
function select(values, value, onChange) {
  const n = node("select");
  for (const key of values) { const option = node("option", t(filterLabel(key))); option.value = key; n.append(option); }
  n.value = value; n.onchange = () => onChange(n.value); return n;
}
function label(text, input) { const n = node("label", text); n.append(input); return n; }
function button(text, click) { const n = node("button", text); n.type = "button"; n.className = "subtle"; n.onclick = click; return n; }

/** Mount an editor with dirty-state protection. preview never saves rules or performs actions. */
export function mountFilterEditor(send, toast, onSaved) {
  const list = document.getElementById("filter-rule-list"), form = document.getElementById("name-rules-form"), feedback = document.getElementById("name-feedback");
  let draft = [], signature = "", dirty = false, stats = [], errors = {}, rendering = false, locale = "";
  const draftKey = "blocksb.filter-draft.v1";
  let latestRules = [], restored = false, previewRevision = 0;
  const previewTimers = new Map();
  const clearPreviews = () => { previewRevision++; for (const timer of previewTimers.values()) clearTimeout(timer); previewTimers.clear(); };
  window.addEventListener("pagehide", clearPreviews);
  const saveDraft = () => { try { localStorage.setItem(draftKey, JSON.stringify({ rules: draft, base: signature, updated: Date.now() })); } catch { /* Keep the editable in-memory draft. */ } };
  const changed = () => { dirty = true; feedback.textContent = t("ui_unsaved_changes"); discard.hidden = false; saveDraft(); };
  const discard = button(t("ui_discard_draft"), () => {
    try { localStorage.removeItem(draftKey); } catch { /* Storage unavailable. */ }
    dirty = false; signature = JSON.stringify(latestRules); draft = structuredClone(latestRules); discard.hidden = true; feedback.textContent = ""; render();
  });
  discard.hidden = true; feedback.parentElement.insertBefore(discard, feedback.nextSibling);
  const hits = id => new Set(stats.filter(e => e.ruleIds.includes(id)).map(e => e.key)).size;
  const newCondition = () => ({ field: "name", op: "contains", value: "", ignoreCase: true });
  function render(openId) {
    clearPreviews(); rendering = true; list.replaceChildren();
    for (const rule of draft) {
      const card = node("details"); card.className = "card filter-rule"; card.dataset.ruleId = rule.id; card.open = rule.id === openId;
      const heading = node("summary"), enabled = node("input"); enabled.type = "checkbox"; enabled.checked = rule.enabled;
      enabled.setAttribute("aria-label", t("ui_filter_enabled")); enabled.onclick = e => e.stopPropagation();
      enabled.onchange = () => { rule.enabled = enabled.checked; changed(); };
      const title = node("strong", rule.name), count = node("span", t("ui_filter_hits", hits(rule.id))); count.className = "muted filter-hit-count";
      heading.append(enabled, title, count); card.append(heading);
      let built = false;
      const build = () => {
      if (built) return; built = true;
      const name = node("input"); name.value = rule.name; name.maxLength = 80; name.required = true;
      name.oninput = () => { rule.name = name.value; title.textContent = name.value; changed(); };
      card.append(label(t("ui_filter_rule_name"), name));
      const mode = select(["all", "any"], rule.mode, value => { rule.mode = value; changed(); });
      card.append(label(t("ui_filter_match"), mode));
      const conditions = node("div"); conditions.className = "filter-conditions";
      function renderConditions() {
        conditions.replaceChildren();
        rule.conditions.forEach((condition, index) => {
          const row = node("div"); row.className = "filter-condition";
          const field = select(fields, condition.field, value => {
            condition.field = value; condition.op = booleanField(value) ? "is" : "contains";
            condition.value = booleanField(value) ? true : ""; condition.ignoreCase = true; changed(); renderConditions();
          }); field.setAttribute("aria-label", t("ui_filter_field")); row.append(field);
          if (booleanField(condition.field)) {
            const value = select(["yes", "no"], condition.value ? "yes" : "no", v => { condition.value = v === "yes"; changed(); });
            value.setAttribute("aria-label", t("ui_filter_value")); row.append(value);
          } else {
            const op = select(["contains", "notContains", "equals", "regex"], condition.op, v => { condition.op = v; changed(); });
            op.setAttribute("aria-label", t("ui_filter_match"));
            const value = node("input"); value.value = condition.value; value.required = true; value.maxLength = 512; value.spellcheck = false;
            value.setAttribute("aria-label", t("ui_filter_value")); value.oninput = () => { condition.value = value.value; changed(); };
            const ignore = node("input"); ignore.type = "checkbox"; ignore.checked = condition.ignoreCase;
            ignore.onchange = () => { condition.ignoreCase = ignore.checked; changed(); };
            row.append(op, value, label(t("ui_filter_ignore_case"), ignore));
          }
          const remove = button(t("ui_filter_remove"), () => { rule.conditions.splice(index, 1); changed(); renderConditions(); queuePreview(); });
          remove.disabled = rule.conditions.length === 1; row.append(remove); conditions.append(row);
        });
      }
      renderConditions(); card.append(conditions);
      card.append(button(t("ui_filter_add_condition"), () => { if (rule.conditions.length >= 8) return; rule.conditions.push(newCondition()); changed(); renderConditions(); queuePreview(); }));
      const action = select(["mask", "block"], rule.action, v => { rule.action = v; changed(); });
      card.append(label(t("ui_filter_action"), action));
      if (errors[rule.id]) { const error = node("p", t("ui_filter_paused_error")); error.className = "record-error"; card.append(error); }
      const preview = node("details"), summary = node("summary", t("ui_filter_preview")); preview.append(summary);
      const sample = {}, inputs = {};
      for (const key of fields) {
        const input = node(key === "text" ? "textarea" : "input");
        if (booleanField(key)) input.type = "checkbox";
        else { input.maxLength = key === "text" ? 14000 : key === "handle" ? 15 : 160; input.spellcheck = false; }
        inputs[key] = input; preview.append(label(t(filterLabel(key)), input));
      }
      const result = node("div"); result.className = "filter-preview"; result.setAttribute("aria-live", "polite");
      let requestRevision = 0, running = false, again = false;
      const tryPreview = async () => {
        if (!preview.open || !card.open || !card.isConnected) return;
        if (running) { again = true; return; }
        running = true; const localRevision = ++requestRevision, generation = previewRevision;
        result.replaceChildren();
        try {
          const current = structuredClone(rule); normalizeFilters([current]);
          for (const key of fields) sample[key] = booleanField(key) ? inputs[key].checked : inputs[key].value;
          const input = { ...sample }, response = await send("PREVIEW_FILTER", { rule: current, sample: input });
          if (generation !== previewRevision || localRevision !== requestRevision || !card.isConnected || !preview.open || again) return;
          if (response.errors?.length) throw new Error(t("ui_filter_preview_error"));
          const outcome = response.results?.[0]; result.append(node("strong", t(outcome?.matched ? "ui_filter_matched" : "ui_filter_not_matched")));
          for (const detail of outcome?.details || []) {
            const line = node("p", `${t(filterLabel(detail.field))}: ${detail.matched ? "✓" : "—"} `), text = String(input[detail.field]);
            if (detail.range && detail.range[1] > detail.range[0]) line.append(document.createTextNode(text.slice(0, detail.range[0])), node("mark", text.slice(...detail.range)), document.createTextNode(text.slice(detail.range[1])));
            else line.append(document.createTextNode(text));
            result.append(line);
          }
        } catch (e) { if (generation === previewRevision && !again) result.textContent = t("ui_filter_invalid", e.message); }
        finally { running = false; if (again && generation === previewRevision) { again = false; queuePreview(); } }
      };
      const queuePreview = () => {
        requestRevision++; result.replaceChildren();
        clearTimeout(previewTimers.get(rule.id));
        if (!preview.open || !card.open) return;
        previewTimers.set(rule.id, setTimeout(() => { previewTimers.delete(rule.id); void tryPreview(); }, 350));
      };
      card.addEventListener("input", queuePreview);
      card.addEventListener("change", queuePreview);
      preview.addEventListener("toggle", queuePreview);
      preview.append(result); card.append(preview);
      card.append(button(t("ui_filter_delete"), () => { draft = draft.filter(r => r !== rule); changed(); render(); }));
      };
      card.ontoggle = () => { if (card.open) build(); };
      if (card.open) build();
      list.append(card);
    }
    rendering = false;
  }
  document.getElementById("filter-add").onclick = () => {
    if (draft.length >= 50) { toast(t("ui_filter_limit")); return; }
    const rule = { id: crypto.randomUUID(), name: t("ui_filter_new"), enabled: true, action: "mask", mode: "all", conditions: [newCondition()] };
    draft.push(rule); changed(); render(rule.id);
  };
  form.onsubmit = async event => {
    event.preventDefault(); const submit = event.submitter; submit.disabled = true;
    try {
      const rules = normalizeFilters(draft);
      await send("SAVE_SETTINGS", { value: { filterRules: rules }, filterSignature: signature });
      dirty = false; signature = ""; discard.hidden = true; try { localStorage.removeItem(draftKey); } catch { /* Storage unavailable. */ } await onSaved(); feedback.textContent = t("ui_saved");
    } catch (e) { toast(t("ui_filter_invalid", e.message)); }
    finally { submit.disabled = false; }
  };
  const update = state => {
    const rules = getFilterRules(state.settings), next = JSON.stringify(rules);
    latestRules = structuredClone(rules);
    if (!restored) {
      restored = true;
      try {
        const saved = JSON.parse(localStorage.getItem(draftKey) || "null");
        // Accept incomplete edits, but never executable data or unbounded structures.
        if (saved && Date.now() - saved.updated < 30 * 86400000 && Array.isArray(saved.rules) && saved.rules.length <= 50
          && saved.rules.every(r => typeof r.id === "string" && /^[a-z0-9_-]{1,64}$/i.test(r.id) && typeof r.name === "string" && r.name.length <= 80
            && typeof r.enabled === "boolean" && ["mask", "block"].includes(r.action) && ["all", "any"].includes(r.mode)
            && Array.isArray(r.conditions) && r.conditions.length > 0 && r.conditions.length <= 8 && r.conditions.every(c => fields.includes(c.field)
              && ["contains", "notContains", "equals", "regex", "is"].includes(c.op) && (typeof c.value === "boolean" || typeof c.value === "string" && c.value.length <= 512)))) {
          draft = saved.rules; signature = typeof saved.base === "string" ? saved.base : next; dirty = true; discard.hidden = false;
          feedback.textContent = t(saved.base === next ? "ui_draft_retained" : "ui_filter_draft_conflict"); render();
        }
      } catch { /* Invalid local drafts do not replace saved rules. */ }
    }
    stats = state.filterEvents || []; errors = state.filterErrors || {};
    if (!dirty && next !== signature && !rendering) { draft = structuredClone(rules); signature = next; render(); }
    if (locale !== globalThis.BlockSBI18n.locale) {
      locale = globalThis.BlockSBI18n.locale; render(list.querySelector("details[open]")?.dataset.ruleId);
      if (dirty) feedback.textContent = t("ui_unsaved_changes");
    }
    for (const card of list.children) card.querySelector(".filter-hit-count").textContent = t("ui_filter_hits", hits(card.dataset.ruleId));
    document.getElementById("name-rules-summary").textContent = t("ui_name_rules_count", rules.filter(r => r.enabled).length);
  };
  /** Seed only a visible unsaved rule. It still requires the user's explicit Save action. */
  update.seed = value => {
    if (!value || !["name", "text"].includes(value.field) || typeof value.value !== "string" || !value.value.trim()) return;
    if (draft.length >= 50) { toast(t("ui_filter_limit")); return; }
    const input = value.value.slice(0, 512);
    const rule = { id: crypto.randomUUID(), name: t("ui_filter_new"), enabled: true, action: "mask", mode: "all", conditions: [{ field: value.field, op: "contains", value: input, ignoreCase: true }] };
    draft.push(rule); changed(); render(rule.id);
    list.querySelector("details[open] input")?.focus();
  };
  return update;
}
