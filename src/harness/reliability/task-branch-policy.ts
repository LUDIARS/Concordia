import { isEditTool, type HarnessAction, type PredicateHit } from "../predicates.js";
import type { BranchSnapshot } from "./task-branch-git.js";

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

const CHECKOUT_MISMATCH: PredicateHit = { rule: "task-branch", decision: "deny",
  reason: "実checkoutとCcの作業登録が一致しません。変更を保持して対象ブランチ・作業を登録してください。" };

/**
 * The Cc registration (repo + branch) is the authority, not the shell's cwd.
 * - Acting inside the registered repository (main checkout or any linked worktree): its branch must be the registered one.
 * - Editing outside the registered repository: denied, the edit would land in an unregistered checkout.
 * - Running a command from outside it: allowed when the registered repository really has the registered branch checked out.
 */
export function checkRegisteredCheckout(input: {
  registered: { repo: string; branch: string };
  acting: BranchSnapshot;
  registeredRepo: BranchSnapshot | null;
  tool: string;
}): PredicateHit | null {
  const { registered, acting, registeredRepo } = input;
  if (!registered.branch || !acting.branch) return CHECKOUT_MISMATCH;
  const sameRepository = acting.repo === registered.repo
    || Boolean(acting.commonDir && acting.commonDir === registeredRepo?.commonDir);
  if (sameRepository) return acting.branch === registered.branch ? null : CHECKOUT_MISMATCH;
  if (isEditTool(input.tool)) return CHECKOUT_MISMATCH;
  return registeredRepo?.checkouts?.some(checkout => checkout.branch === registered.branch) ? null : CHECKOUT_MISMATCH;
}

export type TaskRelation = "same-task" | "new-task" | "unknown";
export interface SubmittedTask {
  repo: string;
  branch: string;
  task: string;
  pr: string;
  relation: TaskRelation;
  version: number;
  /**
   * true = task は `lictor cli task set` 等で宣言したタスク (declared_task)。 false / 未設定は
   * 旧形式で、task に指示文の要約が入っている (人間の指示のたびに変わるため同一性に使えない)。
   */
  declared?: boolean;
  /** PR の表示名 (例 `LUDIARS/Concordia#2150 feat: ...`)。 分類と決定的判定に使う。 */
  label?: string;
}

/**
 * セッションが宣言した作業 (PATCH /v1/sessions/:id の current_task) を保存する metadata キー。
 * current_task 列は人間の指示のたびに要約で上書きされるので、境界の同一性には使えない。
 */
export const DECLARED_TASK_METADATA_KEY = "declared_task";

export function readDeclaredTask(session: { metadata: string | null }): string | null {
  try {
    const value = (JSON.parse(session.metadata || "{}") as Record<string, unknown>)[DECLARED_TASK_METADATA_KEY];
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  }
}

/** 分類器へ渡す「提出済みの作業」の説明。 PR の表示名があれば添える。 */
export function describeSubmittedTask(submitted: SubmittedTask): string {
  return submitted.label ? `${submitted.task} (PR: ${submitted.label}, branch: ${submitted.branch})` : submitted.task;
}

const OTHER_WORK = /(別作業|別件|とは別|以外|新しい作業|new task|another task)/i;

/**
 * 人間の指示や Revisor の通知が、提出済み PR をその番号か branch 名で直接指していれば same-task とする
 * (LLM 分類を待たない)。 別作業を示す語があれば判定しない。 番号は表示名の `#<n>` から取る。
 */
export function deterministicTaskRelation(prompt: string, submitted: SubmittedTask): TaskRelation | null {
  if (!prompt.trim() || OTHER_WORK.test(prompt)) return null;
  if (submitted.branch && prompt.includes(submitted.branch)) return "same-task";
  const number = /#(\d+)/.exec(submitted.label ?? "")?.[1];
  if (!number) return null;
  const mentionsNumber = new RegExp(`(?:#|PR\\s*#?|pull request\\s*#?)${number}(?!\\d)`, "i").test(prompt);
  return mentionsNumber ? "same-task" : null;
}

export function parseTaskRelation(value: unknown): TaskRelation {
  return value === "same-task" || value === "new-task" ? value : "unknown";
}

export function taskStartWarning(branch: string | undefined): string {
  if (branch === "main") return "";
  return `作業開始時のブランチは ${branch || "不明"} です。新規作業はローカル main を起点に分離してください。同じ作業の継続・PR修正かを確認してください。`;
}

/** Revisor / GitHub (pr_records) が正本の、提出済み PR の状態。読めないときは unknown。 */
export type SubmittedPrState = "merged" | "unmerged" | "unknown";

/** TB-MERGED: 正本でマージ済みと確認できた PR の境界だけを外す。unknown は外さない (fail-closed)。 */
export function releasesSubmittedBoundary(state: SubmittedPrState): boolean {
  return state === "merged";
}

/**
 * TB-RECOVER: requiresTaskBranchCheck の例外コマンドだけで組んだ復旧手順。拒否文に載せないと、
 * 分類器が不在のときにセッションが自力で抜け出せない (2026-09-19 実例)。
 */
export const SUBMITTED_BOUNDARY_RECOVERY =
  "記号 (; & | < > $ ` や改行) を含めず単独で打つ次のコマンドはこのゲートの対象外です。"
  + "別作業なら `git worktree add -b <新ブランチ> <パス> main` の後に `lictor cli task set --branch <新ブランチ> --desc \"...\"`、"
  + "PR がマージ済みで作業を終えたなら `lictor cli task set --branch main --desc \"...\"` で登録を main に戻してください。";

/** The classifier can supply evidence, but cannot override an independently changed task/binding. */
export function checkSubmittedTask(input: {
  submitted: SubmittedTask | null;
  repo: string;
  branch: string;
  task: string;
}): PredicateHit | null {
  const previous = input.submitted;
  if (!previous || previous.repo !== input.repo || previous.branch !== input.branch) return null;
  // 宣言タスクどうしの時だけ同一性を比べる。 旧形式 (指示文の要約) は毎回変わるので比べない。
  const taskChanged = previous.declared === true && previous.task !== input.task;
  if (!taskChanged && previous.relation === "same-task") return null;
  return {
    rule: "submitted-task-boundary", decision: "deny",
    reason: taskChanged || previous.relation === "new-task"
      ? `PR ${previous.pr} 提出済みの ${input.branch} に別作業を混ぜることはできません。`
      : `PR ${previous.pr} 提出後の作業が同じPRの修正か未確認です。`,
    suggestion: "同一PRの修正は意図判定を行い、別作業は未コミット変更を保持してローカルmain起点の新しいworktreeへ切り替え、作業登録してください。"
      + SUBMITTED_BOUNDARY_RECOVERY,
  };
}
