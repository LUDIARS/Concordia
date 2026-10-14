/** @implements spec/feature/project-harness-policy.md — filesystem adapter */
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, isAbsolute } from "node:path";

/** Repository-relative candidate path, or null when it escapes the root. */
function candidatePath(root: string, filePath: string): string | null {
  const candidate = relative(resolve(root), resolve(root, filePath)).replace(/\\/g, "/");
  if (!candidate || candidate === ".." || candidate.startsWith("../") || isAbsolute(candidate)) return null;
  return candidate;
}

function domainCovers(domainText: string, candidate: string): boolean {
  const domain = JSON.parse(domainText) as { membership?: Array<{ pathPattern?: string }>; specRefs?: string[] };
  return !!domain.specRefs?.length && !!domain.membership?.some((member) =>
    typeof member.pathPattern === "string" && new RegExp(member.pathPattern).test(candidate));
}

/**
 * Structural prerequisite; semantic DDD quality still belongs to review.
 * Sync variant for the supervisor CLI process only (spec/tasks/full-async-io.md).
 */
export function hasDddEvidence(root: string, filePath: string): boolean {
  const candidate = candidatePath(root, filePath);
  if (!candidate) return false;
  try {
    const ux = readdirSync(resolve(root, "spec/ux")).filter((file) => file.endsWith(".md"));
    if (!ux.some((file) => readFileSync(resolve(root, "spec/ux", file), "utf8").trim().length > 0)) return false;
    return readdirSync(resolve(root, "spec/domains")).filter((file) => file.endsWith(".domain.json"))
      .some((file) => domainCovers(readFileSync(resolve(root, "spec/domains", file), "utf8"), candidate));
  } catch {
    // Caller reports missing/malformed evidence as an explicit gate denial.
    return false;
  }
}

/** Async variant of {@link hasDddEvidence} for request paths inside the service. */
export async function hasDddEvidenceAsync(root: string, filePath: string): Promise<boolean> {
  const candidate = candidatePath(root, filePath);
  if (!candidate) return false;
  try {
    const ux = (await readdir(resolve(root, "spec/ux"))).filter((file) => file.endsWith(".md"));
    let hasUx = false;
    for (const file of ux) {
      if ((await readFile(resolve(root, "spec/ux", file), "utf8")).trim().length > 0) { hasUx = true; break; }
    }
    if (!hasUx) return false;
    const domains = (await readdir(resolve(root, "spec/domains"))).filter((file) => file.endsWith(".domain.json"));
    for (const file of domains) {
      if (domainCovers(await readFile(resolve(root, "spec/domains", file), "utf8"), candidate)) return true;
    }
    return false;
  } catch {
    // Caller reports missing/malformed evidence as an explicit gate denial.
    return false;
  }
}
