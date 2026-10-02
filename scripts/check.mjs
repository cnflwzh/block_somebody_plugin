import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionFiles } from "./extension-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const files = extensionFiles.filter(file => file.endsWith(".js"));
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", resolve(root, file)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Invalid JavaScript: ${file}\n${result.stderr}`);
  if (/apikey_[a-f0-9]{20,}/i.test(readFileSync(resolve(root, file), "utf8"))) throw new Error(`Credential found in distributable source: ${file}`);
  const source = readFileSync(resolve(root, file), "utf8");
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
const html = readFileSync(resolve(root, manifest.options_page), "utf8");
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) if (!/^[a-z]+:/i.test(match[1])) references.push(resolve(root, dirname(manifest.options_page), match[1]));
for (const file of references) if (!existsSync(resolve(root, file))) throw new Error(`Missing extension resource: ${file}`);
for (const file of extensionFiles) if (!existsSync(resolve(root, file))) throw new Error(`Missing release file: ${file}`);
if (manifest.manifest_version !== 3 || manifest.background.type !== "module") throw new Error("Expected a Manifest V3 module service worker.");
console.log(`Syntax and extension resource checks passed (${files.length} JavaScript files).`);
