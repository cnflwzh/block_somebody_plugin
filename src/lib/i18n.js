/* All translated copy lives in Chrome's native _locales/<locale>/messages.json.
 * Chrome loads the catalogs; content scripts and the worker need no async fetch.
 */
(() => {
  if (globalThis.BlockSBI18n) return;
  const language = globalThis.chrome?.i18n?.getUILanguage?.() || "en";
  const locale = /^zh(?:-|_)(?:TW|HK|MO|Hant)/i.test(language) ? "zh-TW"
    : /^zh/i.test(language) ? "zh-CN" : /^ja/i.test(language) ? "ja" : /^ko/i.test(language) ? "ko" : "en";
  /** Resolve a stable message key with ordered substitutions. Values are never translated
   * or parsed as HTML. Chrome provides English fallback for unsupported browser languages.
   */
  function t(key, ...values) {
    return globalThis.chrome?.i18n?.getMessage(key, values.map(value => String(value ?? ""))) || key;
  }
  /** Translate explicitly marked static UI only, once before rendering user content.
   * User prompts, option names, history text and the surrounding X DOM are untouched.
   */
  function localizeDocument(doc) {
    doc.documentElement.lang = locale;
    for (const node of doc.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
    for (const attr of ["title", "aria-label", "placeholder"]) {
      for (const node of doc.querySelectorAll(`[data-i18n-${attr}]`)) node.setAttribute(attr, t(node.getAttribute(`data-i18n-${attr}`)));
    }
    for (const node of doc.querySelectorAll("[data-i18n-value]")) node.value = node.defaultValue = t(node.dataset.i18nValue);
  }
  globalThis.BlockSBI18n = Object.freeze({ t, locale, localizeDocument });
})();
