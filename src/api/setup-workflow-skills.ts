// @spec ハーネス信頼性の実装境界
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
const WORKFLOW_SKILLS = ["cc-feature-investigation", "cc-work-management", "cc-harness-recovery", "cc-development-tools"] as const;

/** Ship the same maintained procedure to both providers; never silently edit user settings. */
/** Shipped skill files do not change while the service runs; read each once, asynchronously. */
const skillContent = new Map<string, Promise<string>>();
function readWorkflowSkill(name: string): Promise<string> {
  let content = skillContent.get(name);
  if (!content) {
    content = readFile(join(SKILLS_ROOT, name, "SKILL.md"), "utf8");
    // Do not pin a failed read; the next request retries.
    content.catch(() => skillContent.delete(name));
    skillContent.set(name, content);
  }
  return content;
}

export async function workflowSkillInstall(repoPath: string, provider: string): Promise<Array<{ target_path: string; content: string }>> {
  const base = repoPath ? repoPath.replace(/[\\/]+$/, "").replace(/\\/g, "/") : "~";
  const directory = provider === "codex-cli" ? (repoPath ? ".agents" : ".codex") : ".claude";
  return Promise.all(WORKFLOW_SKILLS.map(async (name) => ({
    target_path: `${base}/${directory}/skills/${name}/SKILL.md`,
    content: await readWorkflowSkill(name),
  })));
}
