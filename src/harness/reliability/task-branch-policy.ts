import { isEditTool, type HarnessAction, type PredicateHit } from "../predicates.js";

/** Only simple recovery commands bypass a pending task boundary. Opaque shell code is checked. */
export function branchCommandWords(command: string | undefined): string[] {
  if (!command || /[\n\r;&|<>\x24\x60]/.test(command)) return [];
  const words = command.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  return words.map(word => word.replace(/^["']|["']$/g, ""));
}

function gitArguments(words: string[]): string[] | null {
  if (!/^(?:git|git.exe)$/i.test(words[0] || "")) return null;
  return words[1] === "-C" ? words.slice(3) : words.slice(1);
}

export function checkNewBranchCommand(command: string | undefined, baseBranch = "main"): PredicateHit | null {
  const args = gitArguments(branchCommandWords(command));
  if (!args) return null;
  const creates = (args[0] === "worktree" && args[1] === "add" && args.includes("-b"))
    || (args[0] === "switch" && args.includes("-c"))
    || (args[0] === "checkout" && args.includes("-b"));
  if (!creates || args.at(-1) === baseBranch) return null;
  return { rule: "task-main-origin", decision: "deny",
    reason: "新規作業ブランチの起点は " + baseBranch + " です。",
    suggestion: "作成コマンドに起点 " + baseBranch + " を明示してください。" };
}

export function requiresTaskBranchCheck(action: HarnessAction): boolean {
  if (isEditTool(action.tool)) return true;
  if (!action.command) return false;
  const words = branchCommandWords(action.command);
  const args = gitArguments(words);
  if (args) {
    if (args[0] === "status") return false;
    if (args.join(" ") === "branch --show-current" || args.join(" ") === "worktree list --porcelain") return false;
    if (args[0] === "worktree" && args[1] === "add" && args[2] === "-b" && args.length === 6 && args[5] === "main") return false;
  }
  if (/^(?:lictor|lictor.cmd|lictor.exe)$/i.test(words[0] || "") && words[1] === "cli"
    && ((words[2] === "implement" && words[3] === "begin") || (words[2] === "task" && words[3] === "set"))) return false;
  return true;
}

export type TaskRelation = "same-task" | "new-task" | "unknown";
export interface SubmittedTask {
  repo: string;
  branch: string;
  task: string;
  pr: string;
  relation: TaskRelation;
  version: number;
}

export function parseTaskRelation(value: unknown): TaskRelation {
  return value === "same-task" || value === "new-task" ? value : "unknown";
}

export function taskStartWarning(branch: string | undefined): string {
  if (branch === "main") return "";
  return `作業開始時のブランチは ${branch || "不明"} です。新規作業はローカル main を起点に分離してください。同じ作業の継続・PR修正かを確認してください。`;
}

/** The classifier can supply evidence, but cannot override an independently changed task/binding. */
export function checkSubmittedTask(input: {
  submitted: SubmittedTask | null;
  repo: string;
  branch: string;
  task: string;
}): PredicateHit | null {
  const previous = input.submitted;
  if (!previous || previous.repo !== input.repo || previous.branch !== input.branch) return null;
  if (previous.task === input.task && previous.relation === "same-task") return null;
  return {
    rule: "submitted-task-boundary", decision: "deny",
    reason: previous.task !== input.task || previous.relation === "new-task"
      ? `PR ${previous.pr} 提出済みの ${input.branch} に別作業を混ぜることはできません。`
      : `PR ${previous.pr} 提出後の作業が同じPRの修正か未確認です。`,
    suggestion: "同一PRの修正は意図判定を行い、別作業は未コミット変更を保持してローカルmain起点の新しいworktreeへ切り替え、作業登録してください。",
  };
}
