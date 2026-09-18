import { normalizeRepoOrigin } from "../../pr/normalize.js";
import { branchCommandWords } from "./task-branch-policy.js";

/** Recognize a successful gh PR creation result, not a URL quoted in ordinary tool output. */
export function githubSubmission(input: {
  command?: string; message?: string; failed?: boolean; repoOrigin: string | null; branch: string | null;
}): string | null {
  if (input.failed !== false || !input.repoOrigin || !input.branch) return null;
  const words = branchCommandWords(input.command);
  if (!/^(?:gh|gh.exe)$/i.test(words[0] || "")) return null;
  const pr = words.indexOf("pr");
  if (pr < 1 || words[pr + 1] !== "create") return null;
  const head = words.findIndex(word => word === "--head" || word === "-H");
  const headEq = words.find(word => word.startsWith("--head="))?.slice(7);
  if ((head >= 0 && words[head + 1] !== input.branch) || (headEq && headEq !== input.branch)) return null;
  const repo = normalizeRepoOrigin(input.repoOrigin).toLowerCase();
  const urls = input.message?.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? [];
  return urls.find(url => url.split("/").slice(3, 5).join("/").toLowerCase() === repo) ?? null;
}
