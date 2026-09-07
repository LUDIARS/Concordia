/** @implements spec/feature/project-harness-policy.md — filesystem adapter */
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";

/** Structural prerequisite; semantic DDD quality still belongs to review. */
export function hasDddEvidence(root: string, filePath: string): boolean {
  const candidate = relative(resolve(root), resolve(root, filePath)).replace(/\\/g, "/");
  if (!candidate || candidate === ".." || candidate.startsWith("../") || isAbsolute(candidate)) return false;
  try {
    const ux = readdirSync(resolve(root, "spec/ux")).filter((file) => file.endsWith(".md"));
    if (!ux.some((file) => readFileSync(resolve(root, "spec/ux", file), "utf8").trim().length > 0)) return false;
    return readdirSync(resolve(root, "spec/domains")).filter((file) => file.endsWith(".domain.json"))
      .some((file) => {
        const domain = JSON.parse(readFileSync(resolve(root, "spec/domains", file), "utf8")) as {
          membership?: Array<{ pathPattern?: string }>; specRefs?: string[];
        };
        return !!domain.specRefs?.length && !!domain.membership?.some((member) =>
          typeof member.pathPattern === "string" && new RegExp(member.pathPattern).test(candidate));
      });
  } catch {
    // Caller reports missing/malformed evidence as an explicit gate denial.
    return false;
  }
}
