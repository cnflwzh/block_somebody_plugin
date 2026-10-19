import "../lib/i18n.js";
import { FILTER_FILE_LIMIT, parseFilterFile, exportFilterFile } from "../lib/filter-transfer.js";
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
  let latestRules = [], restored = false, previewRevision = 0, subscribedCount = 0;
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
  // Imports remain an editable draft until the existing Save action succeeds.
  const picker = node("input"); picker.type = "file"; picker.accept = ".json,application/json"; picker.multiple = true; picker.hidden = true; form.append(picker);
  const transfer = node("dialog"); transfer.className = "rule-transfer-dialog";
  transfer.setAttribute("aria-labelledby", "rule-transfer-title"); document.body.append(transfer);
  let readingFile = false;
  const download = rules => {
    try {
      const url = URL.createObjectURL(new Blob([exportFilterFile(rules)], { type: "application/json" }));
      const link = node("a"); link.href = url; link.download = `block-sb-filters-${new Date().toISOString().slice(0,10)}.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { toast(t("ui_rules_file_invalid")); }
  };
  function chooseTransfer(rows, importing) {
    transfer.replaceChildren();
    const title = node("h2", t(importing ? "ui_rules_import" : "ui_rules_export")); title.id = "rule-transfer-title";
    const header = node("div"); header.className = "rule-section-heading";
    header.append(title, button(t("ui_close"), () => transfer.close())); transfer.append(header);
    if (importing) transfer.append(node("p", t("ui_rules_import_note")));
    const choices = node("div"); choices.className = "rule-transfer-list";
    const selected = rows.map(() => true), inputs = [];
    const all = node("input"); all.type = "checkbox"; all.checked = true;
    transfer.append(label(t("ui_rules_select_all"), all));
    const confirm = button("", () => {
      const chosen = rows.filter((_, index) => selected[index]); if (!chosen.length) return;
      if (importing) {
        if (draft.length + chosen.length + subscribedCount > 50) { toast(t("ui_filter_limit")); return; }
        draft.push(...chosen); changed(); render(chosen.length === 1 ? chosen[0].id : undefined);
        toast(t("ui_rules_import_ready", chosen.length));
      } else download(chosen);
      transfer.close();
    }); confirm.className = "primary";
    const sync = () => {
      const count = selected.filter(Boolean).length; confirm.disabled = count === 0;
      confirm.textContent = t(importing ? "ui_rules_import_count" : "ui_rules_export_count", count);
      all.checked = count === rows.length; all.indeterminate = count > 0 && count < rows.length;
    };
    rows.forEach((rule, index) => {
      const input = node("input"); input.type = "checkbox"; input.checked = true; inputs.push(input);
      input.onchange = () => { selected[index] = input.checked; sync(); };
      const row = label("", input), info = node("span");
      info.append(node("strong", rule.name), node("small", t(filterLabel(rule.action)))); row.append(info); choices.append(row);
    });
    all.onchange = () => { inputs.forEach((input, index) => { selected[index] = input.checked = all.checked; }); sync(); };
    const footer = node("div"); footer.className = "rule-transfer-footer";
    footer.append(button(t("ui_close"), () => transfer.close()), confirm);
    transfer.append(choices, footer); sync(); transfer.showModal();
  }
  const openImport = () => { if (readingFile) return; picker.value = ""; picker.click(); };
  picker.onchange = async () => {
    const files = [...picker.files]; if (!files.length || readingFile) return;
    if (files.length > 50 || files.reduce((total, file) => total + file.size, 0) > FILTER_FILE_LIMIT) { toast(t("ui_rules_file_large")); return; }
    readingFile = true;
    try {
      const rows = [];
      for (const file of files) { rows.push(...parseFilterFile(await file.text())); if (rows.length > 50) throw new Error("count"); }
      chooseTransfer(rows, true);
    } catch { toast(t("ui_rules_file_invalid")); }
    finally { readingFile = false; picker.value = ""; }
  };
  document.getElementById("filter-import").onclick = openImport;
  document.getElementById("filter-export").onclick = () => {
    if (!draft.length) { toast(t("ui_rules_export_empty")); return; }
    chooseTransfer(draft, false);
  };
  function render(openId) {
    clearPreviews(); rendering = true; list.replaceChildren();
    document.body.classList.toggle("filter-editing", !!openId);
    for (const rule of draft) {
      const card = node("details"); card.className = "card filter-rule"; card.dataset.ruleId = rule.id; card.open = rule.id === openId;
      const heading = node("summary"), enabled = node("input"); enabled.type = "checkbox"; enabled.checked = rule.enabled;
      enabled.setAttribute("aria-label", t("ui_filter_enabled")); enabled.onclick = e => e.stopPropagation();
      enabled.onchange = () => { rule.enabled = enabled.checked; changed(); };
      const title = node("strong", rule.name), count = node("span", t("ui_filter_hits", hits(rule.id))); count.className = "muted filter-hit-count";
      const identity = node("span"); identity.className = "rule-list-identity";
      const actionSummary = node("small", t(filterLabel(rule.action)));
      identity.append(title, actionSummary);
      heading.append(enabled, identity, count); card.append(heading);
      let built = false;
      const build = () => {
      if (built) return; built = true;
      const editorHeading = node("div"); editorHeading.className = "filter-editor-heading";
      editorHeading.append(button(t("ui_back"), () => { card.open = false; }), node("h2", t("dash_edit_rule")));
      const transferActions = node("div"); transferActions.className = "rule-transfer-actions";
      transferActions.append(button(t("ui_rules_import"), openImport), button(t("ui_rules_export_one"), () => download([rule])));
      editorHeading.append(transferActions); card.append(editorHeading);
      const name = node("input"); name.value = rule.name; name.maxLength = 80; name.required = true;
      name.oninput = () => { rule.name = name.value; title.textContent = name.value; changed(); };
      const identity = node("section"); identity.className = "rule-identity";
      const editorEnabled = node("input"); editorEnabled.type = "checkbox"; editorEnabled.role = "switch"; editorEnabled.checked = rule.enabled;
      editorEnabled.onchange = () => { rule.enabled = enabled.checked = editorEnabled.checked; changed(); };
      identity.append(label(t("ui_filter_rule_name"), name), label(t("ui_filter_enabled"), editorEnabled)); card.append(identity);
      const mode = select(["all", "any"], rule.mode, value => { rule.mode = value; changed(); });
      const matchSection = node("section"); matchSection.className = "rule-match-section";
      const matchHeading = node("div"); matchHeading.className = "rule-section-heading";
      matchHeading.append(node("h3", t("ui_rule_conditions")), label(t("ui_filter_match"), mode)); matchSection.append(matchHeading); card.append(matchSection);
      const sampleRows = new Map();
      const conditions = node("div"); conditions.className = "filter-conditions";
      function renderConditions() {
        conditions.replaceChildren();
        for (const [key, row] of sampleRows) row.hidden = !rule.conditions.some(c => c.field === key);
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
            const op = select(["contains", "notContains", "equals", "regex"], condition.op, v => { condition.op = v; row.dataset.operator = v; changed(); });
            op.setAttribute("aria-label", t("ui_filter_match"));
            const value = node("input"); value.value = condition.value; value.required = true; value.maxLength = 512; value.spellcheck = false;
            value.setAttribute("aria-label", t("ui_filter_value")); value.oninput = () => { condition.value = value.value; changed(); };
            const ignore = node("input"); ignore.type = "checkbox"; ignore.checked = condition.ignoreCase;
            ignore.onchange = () => { condition.ignoreCase = ignore.checked; changed(); };
            value.className = "rule-match-value";
            row.dataset.operator = condition.op;
            row.append(op, value, label(t("ui_filter_ignore_case"), ignore));
          }
          const remove = button(t("ui_filter_remove"), () => { rule.conditions.splice(index, 1); changed(); renderConditions(); queuePreview(); });
          remove.disabled = rule.conditions.length === 1;
          const conditionHeading = node("div"); conditionHeading.className = "rule-condition-heading";
          conditionHeading.append(node("strong", t("ui_rule_condition_number", index + 1)), remove); row.prepend(conditionHeading); conditions.append(row);
        });
      }
      renderConditions(); matchSection.append(conditions);
      matchSection.append(button(t("ui_filter_add_condition"), () => { if (rule.conditions.length >= 8) return; rule.conditions.push(newCondition()); changed(); renderConditions(); queuePreview(); }));
      const action = select(["mask", "block"], rule.action, v => { rule.action = v; actionSummary.textContent = t(filterLabel(v)); changed(); });
      const actionSection = node("section"); actionSection.className = "rule-action-section";
      actionSection.append(label(t("ui_filter_action"), action)); card.append(actionSection);
      if (errors[rule.id]) { const error = node("p", t("ui_filter_paused_error")); error.className = "record-error"; card.append(error); }
      const preview = node("details"), summary = node("summary", t("ui_filter_preview")); preview.className = "rule-test-section"; preview.open = true; preview.append(summary);
      const sample = {}, inputs = {};
      for (const key of fields) {
        const input = node(key === "text" ? "textarea" : "input");
        if (booleanField(key)) input.type = "checkbox";
        else { input.maxLength = key === "text" ? 14000 : key === "handle" ? 15 : 160; input.spellcheck = false; }
        inputs[key] = input; const sampleRow = label(t(filterLabel(key)), input); sampleRow.hidden = !rule.conditions.some(c => c.field === key); sampleRows.set(key, sampleRow); preview.append(sampleRow);
      }
      const result = node("div"); result.className = "filter-preview"; result.setAttribute("aria-live", "polite"); result.hidden = true;
      let requestRevision = 0, running = false, again = false;
      const tryPreview = async () => {
        if (!preview.open || !card.open || !card.isConnected) return;
        if (running) { again = true; return; }
        running = true; const localRevision = ++requestRevision, generation = previewRevision;
        result.replaceChildren();
        try {
          const hasSample = rule.conditions.some(c => booleanField(c.field) || inputs[c.field].value.trim());
          result.hidden = !hasSample; if (!hasSample) return;
          const current = structuredClone(rule); normalizeFilters([current]);
          for (const key of fields) sample[key] = booleanField(key) ? inputs[key].checked : inputs[key].value;
          const input = { ...sample }, response = await send("PREVIEW_FILTER", { rule: current, sample: input });
          if (generation !== previewRevision || localRevision !== requestRevision || !card.isConnected || !preview.open || again) return;
          if (response.errors?.length) throw new Error(t("ui_filter_preview_error"));
          const outcome = response.results?.[0]; result.dataset.matched = String(!!outcome?.matched); result.append(node("strong", t(outcome?.matched ? "ui_filter_matched" : "ui_filter_not_matched")));
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
      const deleteRule = button(t("ui_filter_delete"), () => { draft = draft.filter(r => r !== rule); changed(); render(); });
      deleteRule.className = "text-button danger rule-delete"; card.append(deleteRule);
      };
      card.ontoggle = () => {
        if (card.open) { for (const other of list.querySelectorAll("details.filter-rule[open]")) if (other !== card) other.open = false; build(); window.scrollTo(0,0); }
        document.body.classList.toggle("filter-editing", !!list.querySelector("details.filter-rule[open]"));
      };
      if (card.open) build();
      list.append(card);
    }
    rendering = false;
  }
  document.getElementById("filter-add").onclick = () => {
    if (draft.length + subscribedCount >= 50) { toast(t("ui_filter_limit")); return; }
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
    subscribedCount = state.settings.subscriptionRules?.length || 0;
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
    if (draft.length + subscribedCount >= 50) { toast(t("ui_filter_limit")); return; }
    const input = value.value.slice(0, 512);
    const rule = { id: crypto.randomUUID(), name: t("ui_filter_new"), enabled: true, action: "mask", mode: "all", conditions: [{ field: value.field, op: "contains", value: input, ignoreCase: true }] };
    draft.push(rule); changed(); render(rule.id);
    list.querySelector("details[open] input")?.focus();
  };
  return update;
}
