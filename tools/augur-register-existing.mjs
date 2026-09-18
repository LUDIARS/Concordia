#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:9a20ea9a */
import augurContract_1bc1c2f6 from './augur-register-existing.contract.mjs'; /* augur-inject:contract-predicate:873fa024 */

const repo = resolve(process.cwd());
const augur = "E:/Document/Ars/Augur/bin/augur.mjs";
const anatomia = "E:/Document/Ars/Anatomia/bin/anatomia.mjs";
const moduleAnchors = new Map();
let anatomiaLookupUnavailable = false;
const domainDefs = readdirSync(resolve(repo, "spec/domains"))
  .filter((file) => file.endsWith(".domain.json"))
  .map((file) => JSON.parse(readFileSync(resolve(repo, "spec/domains", file), "utf8")));
export function registerTestFile(file) {
  const rel = relative(repo, file).split(sep).join("/");
  const business = matchingDomains(rel);
  if (business.length === 0) return;
  const anchors = anchorsFor(file);
  const output = execFileSync(process.execPath, [
    augur, "tests", "register", "--repo", repo, "--file", rel, "--name", rel,
    "--runner", "vitest", "--json",
    ...business.flatMap((name) => ["--program", name, "--business", name]),
    ...anchors.flatMap((anchor) => ["--anchor", anchor]),
  ], { encoding: "utf8" });
  return JSON.parse(output);
}
// @ts-expect-error augur-inject
registerTestFile = contract(registerTestFile, { ...augurContract_1bc1c2f6, contractId: 'C-9', mode: 'observe', sample: 1, where: 'tools/augur-register-existing.mjs:19', rule: 'contract-wrap', id: '1bc1c2f6' }); /* augur-inject:contract-wrap:1bc1c2f6 */

export function registerExistingTests() {
  for (const root of ["src", "tests"]) {
    const directory = resolve(repo, root);
    if (!existsSync(directory)) continue;
    for (const file of listFiles(directory).filter(isTestFile)) registerTestFile(file);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  registerExistingTests();
}

function matchingDomains(rel) {
  return domainDefs.filter((domain) => (domain.membership ?? []).some((member) => {
    if (!member.pathPattern) return false;
    try { return new RegExp(member.pathPattern).test(rel); } catch { return false; }
  })).map((domain) => domain.name).sort();
}

function anchorsFor(testFile) {
  const source = readFileSync(testFile, "utf8");
  const imports = [...source.matchAll(/(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+(?:[\s\S]*?\s+from\s+)?|require\s*\()(["'])([^"']+)\1/g)]
    .map((match) => match[2])
    .filter((specifier) => specifier.startsWith("."));
  return [...new Set(imports.flatMap((specifier) => anchorsForModule(resolveModule(testFile, specifier))))].sort();
}

function resolveModule(testFile, specifier) {
  const base = resolve(dirname(testFile), specifier);
  const candidates = extname(base) === "" ? [
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].map((extension) => `${base}${extension}`),
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].map((extension) => resolve(base, `index${extension}`)),
  ] : [base];
  return candidates.find((candidate) => existsSync(candidate) && relative(repo, candidate).split(sep).join("/").startsWith("src/"));
}

function anchorsForModule(file) {
  if (file === undefined) return [];
  if (anatomiaLookupUnavailable) return [];
  const cached = moduleAnchors.get(file);
  if (cached !== undefined) return cached;
  const rel = relative(repo, file).split(sep).join("/");
  const query = basename(file, extname(file));
  try {
    const output = execFileSync(process.execPath, [anatomia, "find", query, "--repo", repo, "--json"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const result = JSON.parse(output);
    const hits = Array.isArray(result) ? result : result.hits ?? [];
    const anchors = hits
      .filter((hit) => normalizePath(hit.path ?? hit.file) === rel)
      .map((hit) => hit.anchor ?? hit.anchorId ?? hit.id)
      .filter((anchor) => typeof anchor === "string");
    moduleAnchors.set(file, anchors);
    return anchors;
  } catch {
    anatomiaLookupUnavailable = true;
    const anchors = [];
    moduleAnchors.set(file, anchors);
    return anchors;
  }
}

function normalizePath(path) {
  return typeof path === "string" ? path.replaceAll("\\", "/") : "";
}

function isTestFile(file) {
  return /\.(test|spec)\.tsx?$/.test(file);
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? listFiles(resolve(dir, entry.name)) : [resolve(dir, entry.name)]);
}
