/** @implements spec/feature/shared-startup-context.md — minimal shared resource discovery */
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectStartupWorkflow } from "./project-startup-workflow.js";
import { fileURLToPath } from "node:url";

interface SharedStartupContextInput {
  workflow?: ProjectStartupWorkflow;
  repoPath: string;
  /** Primary project root resolved by Cc registry, not inferred from a worktree name. */
  projectRoot?: string;
  workspaceRoots: readonly string[];
  homeRoot?: string;
  readableFile?: (path: string) => Promise<boolean>;
}

/** Only known resource names are considered; never enumerate or copy private memories. */
export async function buildSharedStartupContext(input: SharedStartupContextInput): Promise<string> {
  const roots = [...new Set(input.workspaceRoots.filter(isAbsolute).map((root) => resolve(root)))];
  const containing = roots.filter((root) => {
    const child = relative(root, resolve(input.repoPath));
    return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
  }).sort((left, right) => right.length - left.length);
  const root = containing[0] ?? (roots.length === 1 ? roots[0] : undefined);
  if (!root) return "【共通資料】Castra root を一意に解決できません。必要な共有スキル・メモリの場所をユーザに確認し、読了したと扱わないでください。";

  const home = input.homeRoot ?? homedir();
  const readable = input.readableFile ?? isReadableFile;
  const skill = (name: string) => [
    join(root, ".claude", "skills", name, "SKILL.md"),
    join(root, ".claude", "skills", `${name}.md`),
    join(home, ".codex", "skills", name, "SKILL.md"),
  ];
  const projectRoot = input.projectRoot && isAbsolute(input.projectRoot) ? resolve(input.projectRoot) : null;
  const projectKey = projectRoot ? projectRoot.replace(/[:\\/]/g, "-") : "";
  const resources: Array<{ label: string; paths: string[] }> = [
    { label: "作業対象・branch 登録", paths: skill("lictor-task-protocol") },
    ...(input.workflow === "revisor" ? [{ label: "Revisor 作業手順", paths: skill("revisor-cc-workflow") }] : []),
    { label: "session-end 終了手順", paths: [join(root, ".claude", "commands", "session-end.md"), ...skill("session-end")] },
    { label: "セッションログ保存", paths: skill("save-session-log") },
    ...(projectRoot ? [
      { label: "対象プロジェクトの作業規則", paths: [join(projectRoot, "AGENTS.md"), join(projectRoot, "CLAUDE.md")] },
      { label: "対象プロジェクトの rule 索引", paths: [join(projectRoot, "rule", "README.md")] },
      { label: "対象プロジェクトのメモリ索引（履歴資料）", paths: [
      join(home, ".claude", "projects", projectKey, "memory", "MEMORY.md"),
      join(root, ".claude", "memory-backup", projectKey, "MEMORY.md"),
      join(root, "Archived", "memory", projectKey, "MEMORY.md"),
    ] }] : []),
  ];
  const lines = [
    "【新規起動時の最小共通コンテキスト】",
    `Castra root: ${JSON.stringify(root)}。cwd は現在のプロジェクトのまま、以下を絶対パスで読んでください。`,
    `資料選択ルール: ${JSON.stringify(fileURLToPath(new URL("../../rule/shared-context.md", import.meta.url)))}`,
  ];
  if (!projectRoot) lines.push("- 対象プロジェクトがCc registryで未確定のため、プロジェクト別資料・メモリは選定していません。対象を確認してください。");
  for (const resource of resources) {
    let found: string | undefined;
    for (const candidate of resource.paths) {
      if (await readable(candidate)) { found = candidate; break; }
    }
    lines.push(found ? `- ${resource.label}: ${JSON.stringify(found)}` : `- ${resource.label}: 見つかりません。必要時に場所を確認してください（未読）。`);
  }
  lines.push("- 読み取り拒否・ファイル消失時は不足した資料名を報告し、読了したと扱わないでください。sandbox の範囲はこの案内では変更されません。");
  return lines.join("\n");
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.R_OK);
    return true;
  } catch { return false; }
}
