import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionFiles } from "./extension-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const messages = JSON.parse(readFileSync(resolve(root, `_locales/${manifest.default_locale}/messages.json`), "utf8"));
const files = extensionFiles.filter(file => file.endsWith(".js"));
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", resolve(root, file)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Invalid JavaScript: ${file}\n${result.stderr}`);
  if (/apikey_[a-f0-9]{20,}/i.test(readFileSync(resolve(root, file), "utf8"))) throw new Error(`Credential found in distributable source: ${file}`);
  const source = readFileSync(resolve(root, file), "utf8");
  for (const match of source.matchAll(/\bt\(\s*["']([a-z][a-z0-9_]*)["']/g)) {
    if (!Object.hasOwn(messages, match[1])) throw new Error(`Missing message in ${file}: ${match[1]}`);
  }
  for (const match of source.matchAll(/\bimport\s+["'](\.[^"']+)["']/g)) {
    if (!existsSync(resolve(root, dirname(file), match[1]))) throw new Error(`Missing side-effect module in ${file}: ${match[1]}`);
  }
  for (const match of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
    if (!existsSync(resolve(root, dirname(file), match[1]))) throw new Error(`Missing module in ${file}: ${match[1]}`);
  }
  for (const match of source.matchAll(/chrome\.runtime\.getURL\(["'`]([^"'`?]+)(?:[?"'`])/g)) {
    if (!existsSync(resolve(root, match[1]))) throw new Error(`Missing runtime resource in ${file}: ${match[1]}`);
  }
}
const references = [manifest.background.service_worker, manifest.options_page, manifest.action.default_popup.split(/[?#]/)[0],
  ...Object.values(manifest.icons || {}), ...Object.values(manifest.action.default_icon || {}),
  ...manifest.content_scripts.flatMap(c => [...(c.js || []), ...(c.css || [])]),
  ...manifest.web_accessible_resources.flatMap(r => r.resources)];
for (const page of extensionFiles.filter(file => file.endsWith(".html"))) {
  const html = readFileSync(resolve(root, page), "utf8");
  for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([a-z][a-z0-9_]*)"/g)) {
    if (!Object.hasOwn(messages, match[1])) throw new Error(`Missing message in ${page}: ${match[1]}`);
  }
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) if (!/^[a-z]+:/i.test(match[1])) references.push(resolve(root, dirname(page), match[1].split(/[?#]/)[0]));
}
for (const file of references) if (!existsSync(resolve(root, file))) throw new Error(`Missing extension resource: ${file}`);
for (const file of extensionFiles) if (!existsSync(resolve(root, file))) throw new Error(`Missing release file: ${file}`);
if (manifest.manifest_version !== 3 || manifest.background.type !== "module") throw new Error("Expected a Manifest V3 module service worker.");
// Locale catalogs are release resources, not UI tests. Check key/placeholder parity so a
// missing translation or broken substitution cannot silently ship in one language.
if (manifest.default_locale !== "en") throw new Error("Expected English as the fallback locale.");
const locales = readdirSync(resolve(root, "_locales"), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
let expectedKeys, expectedSubstitutions;
for (const locale of locales) {
  const path = `_locales/${locale}/messages.json`;
  if (!extensionFiles.includes(path)) throw new Error(`Locale missing from release files: ${path}`);
  const catalog = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const keys = Object.keys(catalog).sort();
  if (expectedKeys && JSON.stringify(keys) !== expectedKeys) throw new Error(`Locale keys differ: ${locale}`);
  expectedKeys ||= JSON.stringify(keys);
  const substitutions = {};
  // JSON member order is not significant; translators may rearrange entries freely.
  for (const name of keys) {
    const entry = catalog[name];
    if (!/^[a-z][a-z0-9_]*$/.test(name) || typeof entry?.message !== "string" || !entry.message.trim()) throw new Error(`Invalid locale message: ${locale}/${name}`);
    const tokens = [...entry.message.matchAll(/\$([a-z][a-z0-9_]*)\$/gi)].map(m => m[1].toLowerCase()).sort();
    const definitions = Object.keys(entry.placeholders || {}).sort();
    if (JSON.stringify([...new Set(tokens)]) !== JSON.stringify(definitions)) throw new Error(`Invalid placeholders: ${locale}/${name}`);
    for (const definition of Object.values(entry.placeholders || {})) {
      if (!/^\$[1-9]$/.test(definition?.content)) throw new Error(`Invalid substitution slot: ${locale}/${name}`);
    }
    substitutions[name] = tokens.map(token => entry.placeholders[token].content).sort();
  }
  if (expectedSubstitutions && JSON.stringify(substitutions) !== expectedSubstitutions) throw new Error(`Locale substitutions differ: ${locale}`);
  expectedSubstitutions ||= JSON.stringify(substitutions);
  for (const field of [manifest.description, manifest.action.default_title]) {
    const key = field.match(/^__MSG_(\w+)__$/)?.[1];
    if (!key || !catalog[key]) throw new Error(`Manifest locale message missing: ${locale}/${field}`);
  }
}
console.log(`Syntax and extension resource checks passed (${files.length} JavaScript files).`);
console.log(`Locale resources and placeholders consistent (${locales.join(", ")}).`);
