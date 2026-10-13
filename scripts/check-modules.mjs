import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceTextModule } from "node:vm";
import { extensionFiles } from "./extension-files.mjs";

// Link without evaluating: Chrome globals are unavailable here, and validation must
// never start background work or make requests. V8 also checks named re-exports.
const root = resolve(process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const files = extensionFiles.filter(file => file.endsWith(".js"));
const allowed = new Set(files.map(file => resolve(root, file)));
const modules = new Map();
function moduleAt(path) {
  if (!allowed.has(path)) throw new Error(`Module outside release files: ${path}`);
  if (!modules.has(path)) modules.set(path, new SourceTextModule(readFileSync(path, "utf8"), { identifier: path }));
  return modules.get(path);
}
for (const file of files) {
  const entry = moduleAt(resolve(root, file));
  if (entry.status !== "unlinked") continue;
  await entry.link((specifier, parent) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) throw new Error(`Nonlocal module in ${parent.identifier}: ${specifier}`);
    return moduleAt(resolve(dirname(parent.identifier), specifier));
  });
}
console.log(`Module imports and exports linked (${modules.size} JavaScript files; no code executed).`);
