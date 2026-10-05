import "./i18n.js";
const { t } = globalThis.BlockSBI18n;

export const RULE_VARIABLES = Object.freeze({ original_post: "variable_original_post", reply: "variable_reply", parent_reply: "variable_parent_reply", reply_is_direct: "variable_reply_is_direct", unseen_media: "variable_unseen_media", incomplete_text: "variable_incomplete_text" });

/** Validate visual/Raw configuration equally. Throws a user-facing error; never evaluates code.
 * Unknown keys and malformed variables are rejected instead of silently lost on mode switches.
 */
export function normalizeRule(value, variables = RULE_VARIABLES) {
  const object = (v, keys, where) => {
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new Error(t("ui_has_unknown_fields_or_an_invalid_format", where));
  };
  const text = (v, max, where, allowEmpty = false) => {
    if (typeof v !== "string" || v.length > max || !allowEmpty && !v.trim()) throw new Error(t("ui_must_be_text_characters", where, allowEmpty ? t("ui_at_most") : t("ui_nonempty_at_most"), max));
    return v;
  };
  const template = (v, where) => {
    const input = text(v, 12000, where);
    const rest = input.replace(/\{\{([\s\S]*?)\}\}/g, (_, name) => {
      if (!Object.hasOwn(variables, name.trim())) throw new Error(t("ui_contains_an_unknown_variable", where, name.slice(0, 60)));
      return "";
    });
    if (rest.includes("{{") || rest.includes("}}")) throw new Error(t("ui_has_unmatched_variable_braces", where));
    return input;
  };
  object(value, ["version", "input", "prompt", "options"], t("ui_rule"));
  if (value.version !== 1) throw new Error(t("ui_unsupported_rule_version_use_version_1"));
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 255) throw new Error(t("ui_set_between_2_and_255_output_options"));
  const ids = new Set();
  const options = value.options.map((option, index) => {
    const where = t("ui_option", index + 1);
    object(option, ["id", "name", "description", "block"], where);
    if (typeof option.id !== "string" || !/^[a-z][a-z0-9_]{0,47}$/.test(option.id) || ["constructor", "prototype"].includes(option.id) || ids.has(option.id)) throw new Error(t("ui_use_a_unique_id_starting_with_a_lowercase_letter_containing", where));
    ids.add(option.id);
    if (typeof option.block !== "boolean") throw new Error(t("ui_block_must_be_true_or_false", where));
    return { id: option.id, name: text(option.name, 60, t("ui_name", where)).trim(), description: text(option.description, 4000, t("ui_criteria", where), true), block: option.block };
  });
  if (!options.some(o => o.block)) throw new Error(t("ui_select_at_least_one_option_that_triggers_blocking"));
  const rule = { version: 1, input: template(value.input, t("ui_input")), prompt: template(value.prompt, t("ui_prompt")), options };
  if (JSON.stringify(rule).length > 120000) throw new Error(t("ui_rule_too_large_shorten_descriptions_max_120_000_characters_total"));
  return rule;
}

/** Expand allowlisted variables once. Braces inside tweet text remain literal, not nested templates. */
export function expandRuleTemplate(template, values, variables = RULE_VARIABLES) {
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_, name) => {
    const key = name.trim();
    if (!Object.hasOwn(variables, key)) throw new Error(t("ui_unknown_variable", key));
    return String(values[key] ?? "");
  });
}
