// @spec ハーネス信頼性の実装境界
/** Structural acceptance adapter; execution results and semantic review are separate evidence. */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { hasDddEvidence } from "../ddd-evidence.js";
import type { ProjectHarnessPolicy } from "../project-policy.js";

const run = promisify(execFile);
const Mapping = z.object({ version: z.literal(1), implementations: z.array(z.object({
  source: z.string().min(1), tests: z.array(z.string()).default([]), contracts: z.array(z.string()).default([]),
})).max(10000) });
const Manifest = z.object({ version: z.literal(1), contracts: z.array(z.object({
  id: z.string(), file: z.string(), module: z.string(), mode: z.string(), sample: z.number(),
})) });

function localText(root: string, name: string): string {
  if (isAbsolute(name)) throw new Error("absolute evidence path");
  const base = realpathSync(root), full = realpathSync(resolve(base, name));
  const rel = relative(base, full);
  if (rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel)) throw new Error("evidence outside repository");
  const stat = statSync(full);
  if (!stat.isFile() || stat.size > 2_000_000) throw new Error("invalid evidence size");
  const text = readFileSync(full, "utf8").trim();
  if (!text) throw new Error("empty evidence");
  return text;
}

export function acceptanceRequirements(policy?: ProjectHarnessPolicy): string[] {
  return [policy?.ddd ? "DDDドメイン定義・所属" : "", policy?.testsRequired || policy?.ontimeTestsRequired ? "変更コードに対応するテスト実装" : "",
    policy?.ontimeTestsRequired ? "Augur observe契約・述語・実行時計測の実装（LLM不要）" : ""].filter(Boolean);
}

/** Callers supply the changed source set; documentation-only changes need no test mapping. */
export function checkCodeAcceptance(root: string, files: readonly string[], policy?: ProjectHarnessPolicy) {
  const required = acceptanceRequirements(policy);
  const sources = files.filter(file => /\.(?:[cm]?[jt]sx?|py|cs|go|rs|java)$/i.test(file)
    && !/(?:^|\/)(?:tests?|spec|contracts)\/|\.(?:test|spec|contract)\.[^/]+$/i.test(file));
  const missing: string[] = [];
  if (!required.length || !sources.length) return { ok: true, required, sources, missing, execution: "not_checked" as const };
  let mappings: z.infer<typeof Mapping>["implementations"] = [];
  let contracts: z.infer<typeof Manifest>["contracts"] = [];
  if (policy?.testsRequired || policy?.ontimeTestsRequired) {
    try { mappings = Mapping.parse(JSON.parse(localText(root, "cc.acceptance.json"))).implementations; }
    catch { missing.push("cc.acceptance.json: missing or invalid implementation/test mapping"); }
  }
  if (policy?.ontimeTestsRequired) {
    try { contracts = Manifest.parse(JSON.parse(localText(root, "augur.contracts.json"))).contracts; }
    catch { missing.push("augur.contracts.json: missing or invalid observe contracts"); }
  }
  for (const source of sources) {
    if (policy?.ddd && !hasDddEvidence(root, source)) missing.push(`${source}: DDD definition/membership missing`);
    const entries = mappings.filter(entry => entry.source === source);
    if (policy?.testsRequired || policy?.ontimeTestsRequired) {
      const tests = entries.flatMap(entry => entry.tests);
      if (!tests.length) missing.push(`${source}: test implementation reference missing`);
      for (const test of tests) {
        try {
          if (test === source || !/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./.test(test)) throw new Error("not test path");
          localText(root, test);
        } catch { missing.push(`${source}: invalid test evidence ${test}`); }
      }
    }
    if (policy?.ontimeTestsRequired) {
      const ids = entries.flatMap(entry => entry.contracts);
      if (!ids.length) missing.push(`${source}: on-time contract reference missing`);
      for (const id of ids) {
        try {
          const matches = contracts.filter(item => item.id === id && item.file === source);
          if (matches.length !== 1 || matches[0].mode !== "observe" || matches[0].sample !== 1) throw new Error("invalid contract");
          localText(root, matches[0].module);
          const code = localText(root, source);
          if (!code.includes("augur-inject:contract-wrap") || !code.includes(id)) throw new Error("instrumentation absent");
        } catch { missing.push(`${source}: missing observe instrumentation/predicate for ${id}`); }
      }
    }
  }
  return { ok: missing.length === 0, required, sources, missing, execution: "not_checked" as const };
}

export async function inspectCodeAcceptance(root: string, policy?: ProjectHarnessPolicy, expectedBranch?: string | null) {
  if (!acceptanceRequirements(policy).length) return checkCodeAcceptance(root, [], policy);
  try {
    const options = { cwd: root, timeout: 5000, maxBuffer: 2_000_000, windowsHide: true };
    const { stdout: top } = await run("git", ["rev-parse", "--show-toplevel"], options);
    const repo = top.trim();
    if (expectedBranch) {
      const { stdout: branch } = await run("git", ["branch", "--show-current"], options);
      if (branch.trim() !== expectedBranch) throw new Error("Acceptance checkout differs from submission branch");
    }
    // Include committed branch changes plus staged/unstaged implementation. Deleted files are not new implementations.
    const { stdout } = await run("git", ["diff", "--name-only", "--diff-filter=ACMR", "-z", "main", "--"], { ...options, cwd: repo });
    const { stdout: untracked } = await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { ...options, cwd: repo });
    return checkCodeAcceptance(repo, [...new Set((stdout + untracked).split("\0").filter(Boolean))], policy);
  } catch {
    return { ok: false, required: acceptanceRequirements(policy), sources: [], missing: ["Changed files or acceptance evidence unavailable"], execution: "not_checked" as const };
  }
}
