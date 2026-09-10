#!/usr/bin/env node
// @spec ハーネス信頼性の実装境界
// Deterministic Augur orchestration. No classifier/model endpoint, no service startup.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

const [action, ...args] = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const root = realpathSync(flag("--project") ?? process.cwd());
const augur = flag("--augur");
if (!augur || !["install", "lint", "report"].includes(action)) {
  process.stderr.write("Usage: node tools/concordia-ontime.mjs <install|lint|report> --augur <Augur/bin/augur.mjs> [--project <repo>] [--logs-dir <dir>] [--since <ISO>]\n");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(resolve(root, "augur.contracts.json"), "utf8"));
if (manifest.version !== 1 || !Array.isArray(manifest.contracts) || !manifest.contracts.length
  || manifest.contracts.some(item => item.mode !== "observe" || item.sample !== 1)) throw Error("Expected nonempty observe-only Augur contracts with sample=1");
const paths = manifest.contracts.map(item => {
  const path = realpathSync(resolve(root, item.file));
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw Error("Contract target outside repository");
  return path;
});
const command = action === "install" ? ["inject", "apply", "--rule", "contract-wrap", "--include-existing"]
  : ["contracts", action, "--json"];
if (action === "report") {
  const since = flag("--since");
  if (!since || !Number.isFinite(Date.parse(since))) throw Error("report requires explicit --since ISO; do not reuse historical observations as current acceptance");
  command.push("--since", since, "--acceptance");
  if (flag("--logs-dir")) command.push("--logs", flag("--logs-dir"));
}
const result = spawnSync(process.execPath, [resolve(augur), ...command, "--project", root], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (action === "install") {
  // Augur emits .ts predicate imports. Cc uses Node16 .js specifiers for emitted JS.
  // Preserve marker identities; normalize only generated predicate-import lines.
  for (const path of new Set(paths)) {
    const source = readFileSync(path, "utf8");
    const normalized = source.replace(/^(import .+ from ['"][^'"\r\n]+)\.ts(['"]; \/\* augur-inject:contract-predicate:[a-f0-9]+ \*\/)/gm, "$1.js$2");
    if (source !== normalized) writeFileSync(path, normalized, "utf8");
  }
}
