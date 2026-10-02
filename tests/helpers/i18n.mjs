import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Core tests assert Chinese error messages and replace chrome with their own service mocks.
// Keep the real translation helper in a separate context so those replacements do not
// remove its i18n API. This fixture uses shipped copy and never loads UI or contacts Chrome.
const catalog = JSON.parse(readFileSync(new URL("../../_locales/zh_CN/messages.json", import.meta.url), "utf8"));
const context = { chrome: { i18n: {
  getUILanguage: () => "zh-CN",
  getMessage(key, substitutions = []) {
    const entry = catalog[key];
    if (!entry) throw new Error(`Missing fixture translation: ${key}`);
    return entry.message.replace(/\$\$|\$([a-z][a-z0-9_]*)\$/gi, (token, name) => {
      if (token === "$$") return "$";
      const content = entry.placeholders?.[name.toLowerCase()]?.content;
      if (!/^\$[1-9]$/.test(content)) throw new Error(`Invalid fixture placeholder: ${key}/${name}`);
      return String(substitutions[Number(content.slice(1)) - 1] ?? "");
    });
  }
} } };
runInNewContext(readFileSync(new URL("../../src/lib/i18n.js", import.meta.url), "utf8"), context);
export const testI18n = context.BlockSBI18n;
globalThis.BlockSBI18n = testI18n;
