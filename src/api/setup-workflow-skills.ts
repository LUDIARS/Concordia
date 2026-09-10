// @spec ハーネス信頼性の実装境界
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
const WORKFLOW_SKILLS = ["cc-feature-investigation", "cc-work-management", "cc-harness-recovery"] as const;

/** Ship the same maintained procedure to both providers; never silently edit user settings. */
export function workflowSkillInstall(repoPath: string, provider: string): Array<{ target_path: string; content: string }> {
  const base = repoPath ? repoPath.replace(/[\\/]+$/, "").replace(/\\/g, "/") : "~";
  const directory = provider === "codex-cli" ? (repoPath ? ".agents" : ".codex") : ".claude";
  return WORKFLOW_SKILLS.map((name) => ({
    target_path: `${base}/${directory}/skills/${name}/SKILL.md`,
    content: readFileSync(join(SKILLS_ROOT, name, "SKILL.md"), "utf8"),
  }));
}
