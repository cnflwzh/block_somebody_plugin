import "../lib/i18n.js";
const { t, localizeDocument } = globalThis.BlockSBI18n;
import { RULE_VARIABLES, getAnalysisRule, normalizeRule, buildRequest } from "../lib/core.js";
localizeDocument(document);

// This extension-owned editor saves a typed rule, never executable code or login credentials.
const $ = id => document.getElementById(id);
let draft, revision = 0, model = "", mode = "visual", dirty = false, busy = false, previewRule;
let loading = false, reloadAgain = false;
const modes = [$("visual-mode"), $("raw-mode")];
const actions = [$("restore-default"), $("preview-request"), $("save-rule")];
const element = (tag, className, text) => {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
};
async function send(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (!result?.ok) throw new Error(result?.error || t("ui_cannot_connect_to_the_extension_reload_the_extension_and_this"));
  return result.data;
}
function error(message = "") { $("error").textContent = String(message); $("error").hidden = !message; }
function markDirty() { dirty = true; $("save-state").textContent = t("ui_unsaved_changes"); error(); }
function setBusy(value) {
  busy = value; $("editor-fields").disabled = value || !draft;
  [...modes, ...actions].forEach(button => { button.disabled = value || !draft; });
  $("reload-rule").disabled = value; $("retry-load").disabled = value;
}

/** Collect the active editor without discarding invalid Raw text. Saving and previews validate here. */
function collect() {
  if (mode === "raw") {
    let value;
    try { value = JSON.parse($("raw-editor").value); } catch { throw new Error(t("ui_invalid_json_check_brackets_commas_and_quotes")); }
    return normalizeRule(value);
  }
  return normalizeRule(draft);
}

function optionButton(text, title, action) {
  const button = element("button", "", text); button.type = "button"; button.title = title;
  button.setAttribute("aria-label", title); button.onclick = action; return button;
}

/** Render option controls only on structural edits; typing never remounts the focused field. */
function renderOptions() {
  const list = $("options-list"); list.replaceChildren();
  draft.options.forEach((option, index) => {
    const card = element("article", "option"), heading = element("div", "option-heading");
    const name = element("input", "option-name"); name.value = option.name; name.maxLength = 60;
    name.placeholder = t("ui_option_name"); name.setAttribute("aria-label", t("ui_option_name_2", index + 1));
    name.oninput = () => { option.name = name.value; markDirty(); };
    const check = element("label", "check"), enabled = element("input"); enabled.type = "checkbox"; enabled.checked = option.block;
    enabled.onchange = () => { option.block = enabled.checked; markDirty(); };
    check.append(enabled, document.createTextNode(t("ui_block_on_match"))); heading.append(name, check);
    const description = element("textarea", "option-description"); description.value = option.description; description.rows = 2; description.maxLength = 4000;
    description.placeholder = t("ui_criteria_which_replies_belong_in_this_category"); description.setAttribute("aria-label", t("ui_option_criteria", index + 1));
    description.oninput = () => { option.description = description.value; markDirty(); };
    const footer = element("div", "option-footer"), details = element("details"), summary = element("summary", "", t("ui_internal_id", option.id));
    const id = element("input"); id.value = option.id; id.maxLength = 48; id.spellcheck = false; id.setAttribute("aria-label", t("ui_option_internal_id", index + 1));
    id.oninput = () => { option.id = id.value; summary.textContent = t("ui_internal_id", id.value); markDirty(); };
    details.append(summary, id);
    const controls = element("div", "option-controls");
    const move = direction => {
      [draft.options[index], draft.options[index + direction]] = [draft.options[index + direction], draft.options[index]];
      markDirty(); renderOptions();
    };
    const up = optionButton("↑", t("ui_move_up"), () => move(-1)); up.disabled = index === 0;
    const down = optionButton("↓", t("ui_move_down"), () => move(1)); down.disabled = index === draft.options.length - 1;
    const remove = optionButton(t("ui_delete"), t("ui_delete_option"), () => { draft.options.splice(index, 1); markDirty(); renderOptions(); }); remove.disabled = draft.options.length <= 2;
    controls.append(up, down, remove); footer.append(details, controls); card.append(heading, description, footer); list.append(card);
  });
  $("add-option").disabled = draft.options.length >= 255;
}
function renderVisual() { $("input-template").value = draft.input; $("prompt-template").value = draft.prompt; renderOptions(); }

function switchMode(next) {
  if (busy || !draft || mode === next) return;
  try {
    // An unfinished visual draft can be copied in Raw; returning requires a lossless, valid schema.
    if (next === "raw") $("raw-editor").value = JSON.stringify(draft, null, 2);
    else { draft = collect(); renderVisual(); }
    mode = next; $("visual-panel").hidden = next !== "visual"; $("raw-panel").hidden = next !== "raw";
    modes.forEach(button => button.setAttribute("aria-pressed", String(button.id === `${next}-mode`))); error();
  } catch (e) { error(e.message); }
}
modes.forEach(button => { button.onclick = () => switchMode(button.id === "visual-mode" ? "visual" : "raw"); });

for (const [field, property, container] of [["input-template", "input", "input-variables"], ["prompt-template", "prompt", "prompt-variables"]]) {
  const textarea = $(field);
  textarea.oninput = () => { draft[property] = textarea.value; markDirty(); };
  for (const [name, label] of Object.entries(RULE_VARIABLES)) {
    const button = optionButton(t(label), t("ui_insert", name), () => {
      const token = `{{${name}}}`, start = textarea.selectionStart, end = textarea.selectionEnd;
      if (textarea.value.length - (end - start) + token.length > 12000) { error(t("ui_templates_can_contain_up_to_12_000_characters")); return; }
      textarea.setRangeText(token, start, end, "end"); draft[property] = textarea.value; textarea.focus(); markDirty();
    });
    button.onmousedown = event => event.preventDefault(); $(container).append(button);
  }
}
$("raw-editor").oninput = markDirty;
$("add-option").onclick = () => {
  const ids = new Set(draft.options.map(o => o.id)); let n = 1; while (ids.has(`option_${n}`)) n++;
  draft.options.push({ id: `option_${n}`, name: "", description: "", block: false }); markDirty(); renderOptions();
  $("options-list").lastElementChild.querySelector("input").focus();
};
$("restore-default").onclick = () => {
  draft = getAnalysisRule({}); renderVisual(); $("raw-editor").value = JSON.stringify(draft, null, 2); markDirty();
};

/** Preview uses synthetic text and the same compiler as the worker, with no network side effects. */
function renderPreview() {
  const root = { id: "100000", text: $("sample-root").value, hasMedia: $("sample-media").checked, incomplete: $("sample-incomplete").checked };
  const parentText = $("sample-parent").value;
  const parent = parentText.trim() ? { id: "100002", text: parentText, parentId: root.id } : null;
  const reply = { id: "100001", text: $("sample-reply").value, parentId: parent?.id || root.id };
  $("request-output").textContent = JSON.stringify(buildRequest(root, reply, parent, model, "", previewRule), null, 2);
}
$("preview-request").onclick = () => {
  try { previewRule = collect(); renderPreview(); error(); $("preview-dialog").showModal(); }
  catch (e) { error(e.message); }
};
$("preview-dialog").addEventListener("input", () => {
  try { renderPreview(); } catch (e) { $("request-output").textContent = t("ui_cannot_preview", e.message); }
});
$("close-preview").onclick = () => $("preview-dialog").close();

$("save-rule").onclick = async () => {
  if (busy || !draft) return;
  try {
    const rule = collect(); setBusy(true); error(); $("save-state").textContent = t("ui_saving");
    const saved = await send("SAVE_RULE_CONFIG", { rule, revision });
    draft = saved.rule; revision = saved.revision; dirty = false; renderVisual();
    $("raw-editor").value = JSON.stringify(draft, null, 2); $("conflict").hidden = true;
    $("save-state").textContent = t("ui_saved");
  } catch (e) { error(e.message); $("save-state").textContent = dirty ? t("ui_unsaved_changes") : t("ui_save_failed"); }
  finally { setBusy(false); if (reloadAgain) { reloadAgain = false; void load(); } }
};

/** Revision checks prevent a second editor or a model connection check from overwriting this draft. */
async function load() {
  if (loading || busy) { reloadAgain = true; return; }
  loading = true;
  try {
    const latest = await send("RULE_CONFIG");
    if (busy) { reloadAgain = true; return; }
    if (latest.revision < revision) return;
    // Queue notifications can be frequent. Do not reset selection/scroll for an unchanged rule.
    if (draft && latest.revision === revision) return;
    if (dirty) {
      if (latest.revision !== revision) $("conflict").hidden = false;
      return;
    }
    draft = latest.rule; revision = latest.revision; model = latest.model;
    renderVisual(); $("raw-editor").value = JSON.stringify(draft, null, 2);
    $("save-state").textContent = t("ui_saved"); $("retry-load").hidden = true; $("conflict").hidden = true; error();
  } catch (e) { error(e.message); $("retry-load").hidden = false; }
  finally {
    loading = false;
    // A save may have started during the read; its controls stay locked until its own finally.
    if (!busy) { setBusy(false); if (reloadAgain) { reloadAgain = false; void load(); } }
  }
}
$("reload-rule").onclick = () => {
  if (dirty && !confirm(t("ui_discard_unsaved_changes_and_load_the_latest_settings"))) return;
  dirty = false; void load();
};
$("retry-load").onclick = () => void load();
window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
chrome.runtime.onMessage.addListener(message => { if (message?.type === "STATE_CHANGED") void load(); });
void load();
