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
  const changed = () => { dirty = true; feedback.textContent = t("ui_unsaved_changes"); };
  const hits = id => new Set(stats.filter(e => e.ruleIds.includes(id)).map(e => e.key)).size;
  const newCondition = () => ({ field: "name", op: "contains", value: "", ignoreCase: true });
  function render(openId) {
    rendering = true; list.replaceChildren();
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
          const remove = button(t("ui_filter_remove"), () => { rule.conditions.splice(index, 1); changed(); renderConditions(); });
          remove.disabled = rule.conditions.length === 1; row.append(remove); conditions.append(row);
        });
      }
      renderConditions(); card.append(conditions);
      card.append(button(t("ui_filter_add_condition"), () => { if (rule.conditions.length >= 8) return; rule.conditions.push(newCondition()); changed(); renderConditions(); }));
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
      const tryButton = button(t("ui_filter_try"), async () => {
        result.replaceChildren(); tryButton.disabled = true;
        try {
          normalizeFilters([rule]);
          for (const key of fields) sample[key] = booleanField(key) ? inputs[key].checked : inputs[key].value;
          const response = await send("PREVIEW_FILTER", { rule, sample });
          if (response.errors?.length) throw new Error(t("ui_filter_preview_error"));
          const outcome = response.results?.[0]; result.append(node("strong", t(outcome?.matched ? "ui_filter_matched" : "ui_filter_not_matched")));
          for (const detail of outcome?.details || []) {
            const line = node("p", `${t(filterLabel(detail.field))}: ${detail.matched ? "✓" : "—"} `);
            const text = String(sample[detail.field]);
            if (detail.range && detail.range[1] > detail.range[0]) {
              line.append(document.createTextNode(text.slice(0, detail.range[0])), node("mark", text.slice(...detail.range)), document.createTextNode(text.slice(detail.range[1])));
            } else line.append(document.createTextNode(text));
            result.append(line);
          }
        } catch (e) { result.textContent = t("ui_filter_invalid", e.message); }
        finally { tryButton.disabled = false; }
      }); preview.append(tryButton, result); card.append(preview);
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
      dirty = false; signature = ""; await onSaved(); feedback.textContent = t("ui_saved");
    } catch (e) { toast(t("ui_filter_invalid", e.message)); }
    finally { submit.disabled = false; }
  };
  return state => {
    const rules = getFilterRules(state.settings), next = JSON.stringify(rules);
    stats = state.filterEvents || []; errors = state.filterErrors || {};
    if (!dirty && next !== signature && !rendering) { draft = structuredClone(rules); signature = next; render(); }
    if (locale !== globalThis.BlockSBI18n.locale) {
      locale = globalThis.BlockSBI18n.locale; render(list.querySelector("details[open]")?.dataset.ruleId);
      if (dirty) feedback.textContent = t("ui_unsaved_changes");
    }
    for (const card of list.children) card.querySelector(".filter-hit-count").textContent = t("ui_filter_hits", hits(card.dataset.ruleId));
    document.getElementById("name-rules-summary").textContent = t("ui_name_rules_count", rules.filter(r => r.enabled).length);
  };
}
