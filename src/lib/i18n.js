/* Chrome's standard catalogs are the only translation source. Automatic language uses
 * chrome.i18n; an explicit preference reads the same packaged, public JSON resources.
 * Callers supply settings from a trusted snapshot: content scripts never read storage.
 */
(() => {
  if (globalThis.BlockSBI18n) return;
  let nativeUnavailable = false, browserLanguage = "en";
  try { browserLanguage = globalThis.chrome?.i18n?.getUILanguage?.() || "en"; }
  catch { nativeUnavailable = true; }
  const browserLocale = /^zh(?:-|_)(?:TW|HK|MO|Hant)/i.test(browserLanguage) ? "zh-TW"
    : /^zh/i.test(browserLanguage) ? "zh-CN" : /^ja/i.test(browserLanguage) ? "ja" : /^ko/i.test(browserLanguage) ? "ko" : "en";
  const locales = Object.freeze({ zh_CN: "zh-CN", zh_TW: "zh-TW", en: "en", ja: "ja", ko: "ko" });
  const catalogs = new Map();
  let language = "auto", requested = "auto", dictionary = null, fallback = null, generation = 0;
  let pending = Promise.resolve();
  function loadCatalog(code) {
    if (!catalogs.has(code)) {
      const promise = (async () => {
        const url = globalThis.chrome?.runtime?.getURL?.(`_locales/${code}/messages.json`);
        if (!url || typeof globalThis.fetch !== "function") throw new Error("Translation resource unavailable");
        const response = await globalThis.fetch(url);
        if (!response.ok) throw new Error("Translation resource unavailable");
        const value = await response.json();
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid translation catalog");
        return value;
      })().catch(error => { catalogs.delete(code); throw error; });
      catalogs.set(code, promise);
    }
    return catalogs.get(code);
  }
  /** Apply a supported catalog name, or "auto". Only extension resources are fetched.
   * Resolves after installation (or native fallback on load failure); overlapping calls
   * are last-wins. Nothing is persisted here, so storage authorization stays with callers.
   */
  function setLanguage(value) {
    const next = typeof value === "string" && Object.hasOwn(locales, value) ? value : "auto";
    if (requested === next) return pending;
    requested = next;
    const requestGeneration = ++generation;
    if (next === "auto") {
      language = "auto"; dictionary = null; fallback = null;
      return pending = Promise.resolve();
    }
    return pending = Promise.all([loadCatalog(next), loadCatalog("en")]).then(([selected, english]) => {
      if (requestGeneration !== generation) return;
      dictionary = selected; fallback = english; language = next;
    }).catch(() => {
      if (requestGeneration !== generation) return;
      language = "auto"; dictionary = null; fallback = null;
      requested = "auto"; // A later snapshot may retry a transient resource failure.
    });
  }
  // Resolve placeholders in one pass. Substitution values are literal text and must not
  // be interpreted again, even if an account name or model text contains "$1" or HTML.
  function format(entry, values) {
    const positional = text => text.replace(/\$\$|\$([1-9][0-9]*)/g, (token, index) => token === "$$" ? "$" : values[Number(index) - 1] ?? "");
    return entry.message.replace(/\$\$|\$([a-z][a-z0-9_]*)\$|\$([1-9][0-9]*)/gi, (token, name, index) => {
      if (token === "$$") return "$";
      if (index) return values[Number(index) - 1] ?? "";
      const key = Object.keys(entry.placeholders || {}).find(key => key.toLowerCase() === name.toLowerCase());
      const content = key && entry.placeholders[key]?.content;
      return typeof content === "string" ? positional(content) : token;
    });
  }
  /** Resolve a stable message key with ordered substitutions. Values are never translated
   * or parsed as HTML. Chrome provides English fallback for unsupported browser languages.
   */
  function t(key, ...values) {
    const substitutions = values.map(value => String(value ?? ""));
    const entry = dictionary?.[key] || fallback?.[key];
    if (entry && typeof entry.message === "string") return format(entry, substitutions);
    // Optional chaining cannot protect APIs whose object survives an extension reload
    // but whose native implementation throws "Extension context invalidated".
    if (!nativeUnavailable) try { return globalThis.chrome?.i18n?.getMessage(key, substitutions) || key; }
    catch { nativeUnavailable = true; }
    return key;
  }
  /** Translate explicitly marked static UI only, once before rendering user content.
   * User prompts, option names, history text and the surrounding X DOM are untouched.
   */
  function localizeDocument(doc) {
    doc.documentElement.lang = locales[language] || browserLocale;
    for (const node of doc.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
    for (const attr of ["title", "aria-label", "placeholder"]) {
      for (const node of doc.querySelectorAll(`[data-i18n-${attr}]`)) node.setAttribute(attr, t(node.getAttribute(`data-i18n-${attr}`)));
    }
    for (const node of doc.querySelectorAll("[data-i18n-value]")) node.value = node.defaultValue = t(node.dataset.i18nValue);
  }
  globalThis.BlockSBI18n = Object.freeze({ t, get locale() { return locales[language] || browserLocale; },
    localizeDocument, get ready() { return pending; }, setLanguage });
})();
