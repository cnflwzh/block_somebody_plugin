import { mkdirSync, copyFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionFiles } from "./extension-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Explicit allowlist: local credentials, original design files, and development fixtures never ship.
const files = extensionFiles;
const output = resolve(root, "dist");
// Validate every input before touching an existing build, then discard stale release files.
// Refuse a redirected output directory so cleanup cannot reach outside this workspace.
if (existsSync(output) && realpathSync(output) !== resolve(realpathSync(root), "dist")) throw new Error("Refusing to clean a redirected dist directory.");
for (const file of files) {
  const source = resolve(root, file);
  if (/apikey_[a-f0-9]{20,}/i.test(readFileSync(source, "utf8"))) throw new Error(`Credential found in source: ${file}`);
}
rmSync(output, { recursive: true, force: true });
for (const file of files) {
  const source = resolve(root, file);
  const target = resolve(output, file);
  mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
}
console.log(`Built ${files.length} files in dist/. No dependencies or bundler required.`);
