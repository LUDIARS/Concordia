import { basename } from "node:path";
import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { scanReposMulti } from "../work/repo-scan.js";

export const INITIAL_WORK_QUESTION =
  "開発対象のブランチ/開発コードを選択してください。候補にない場合や複数リポジトリにまたがる場合は自由入力してください。";

export interface InitialWorkTarget {
  repo: string;
  branch: string;
  raw: string;
}

export async function buildInitialWorkOptions(
  sessions: SessionsRepo,
  session: SessionRow,
  roots: readonly string[],
): Promise<Array<{ label: string; description?: string }>> {
  const out: Array<{ label: string; description?: string }> = [];
  const seen = new Set<string>();
  const add = (repo: string, branch: string | null | undefined, description?: string | null) => {
    const cleanRepo = repo.trim() || "repo";
    const cleanBranch = (branch ?? "").trim() || "branch未確定";
    const label = `${cleanRepo}: ${cleanBranch}`;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, ...(description ? { description } : {}) });
  };

  add(repoNameFromPath(session.repo_path), session.branch, "現在の起動ディレクトリ");

  const repos = await scanReposMulti(roots, sessions).catch(() => []);
  for (const repo of repos) {
    add(repo.name, repo.branch, repo.path);
    for (const wt of repo.worktrees) add(repo.name, wt.branch, wt.path);
    if (out.length >= 25) break;
  }

  return out.slice(0, 25);
}

export function maybeParseInitialWorkTarget(question: string, answerText: string, session: SessionRow): InitialWorkTarget | null {
  if (question !== INITIAL_WORK_QUESTION) return null;
  const raw = answerText.trim();
  if (!raw) return null;

  const first = raw.split(/\r?\n|[,、]/).map((s) => s.trim()).find(Boolean) ?? raw;
  const paren = /^(.+?)\((.+?)\)\s*開発中?$/.exec(first) ?? /^(.+?)\((.+?)\)$/.exec(first);
  if (paren) {
    return normalizeTarget(paren[2], paren[1], raw, session);
  }

  const colon = /^([^:：/]+)\s*[:：/]\s*(.+)$/.exec(first);
  if (colon) {
    return normalizeTarget(colon[1], colon[2], raw, session);
  }

  return normalizeTarget(repoNameFromPath(session.repo_path), first, raw, session);
}

export function formatDevelopmentTitle(target: InitialWorkTarget): string {
  return `${target.branch}(${target.repo})開発中`.slice(0, 120);
}

/**
 * 初期ワーク選択 (= 開発対象リポ確定) 後に wrapped session へ流し込む inject の source。
 * `discord:`/`slack:` で始まらないので participants ミラー対象から外れ、制御 inject 扱いになる。
 */
export const INITIAL_WORK_INJECT_SOURCE = "auto:initial-work";

/**
 * 開発対象リポを選んだ直後に session AI へ与える指示文を組み立てる純関数。
 *
 * 背景: 初期ワーク質問の回答は Concordia がタイトルに反映するだけで、
 * 「次に何をするか」 を AI に伝えていなかった。 そのため Lictor 側では
 * picker 用キーストローク fallback に落ちて空プロンプトで no-op (= Discord は無反応)、
 * プラットフォームによっては勝手に作業を始める、 と挙動が割れていた。
 *
 * ここで決定論的な指示を text inject すると、 回答経路 (Discord/Slack) に依らず
 * 同じ流れ (残タスク取得 → 一覧提示 → 実行可否の問い合わせ) に揃う。
 *
 * 件数が事前に読めないため、 選択肢ピッカー (AskUserQuestion) ではなく
 * 自由文での確認を明示する。
 */
export function buildInitialWorkInjectText(target: InitialWorkTarget): string {
  const repo = target.repo.trim() || "選択したリポジトリ";
  const branch = target.branch.trim();
  const where = branch ? `「${repo} / ${branch}」` : `「${repo}」`;
  return [
    `開発対象として ${where} を選択しました。`,
    `まずタスク管理アプリ (Memoria / Actio など) から ${repo} の残タスクを取得し、一覧をこのチャットに提示してください。`,
    `そのうえで、どれを実行するか (または実行しないか) をユーザに問い合わせてください。`,
    `タスク件数が事前に読めないため、AskUserQuestion (選択肢ピッカー) は使わず、自由文で確認してください。`,
  ].join("\n");
}

export function markInitialWorkQuestionAsked(
  pendingQuestions: DiscordPendingQuestionsRepo,
  session: SessionRow,
  options: Array<{ label: string; description?: string }>,
): { questionId: number; deduped: boolean } {
  const existing =
    pendingQuestions.findUnansweredByQuestion(session.id, INITIAL_WORK_QUESTION) ??
    pendingQuestions.findRecentlyAnsweredByQuestion(session.id, INITIAL_WORK_QUESTION, Math.floor(Date.now() / 1000) - 600);
  if (existing) return { questionId: existing.id, deduped: true };
  const row = pendingQuestions.insert({
    session_id: session.id,
    question: INITIAL_WORK_QUESTION,
    options,
  });
  return { questionId: row.id, deduped: false };
}

function normalizeTarget(repo: string, branch: string, raw: string, session: SessionRow): InitialWorkTarget {
  const cleanRepo = repo.trim() || repoNameFromPath(session.repo_path);
  const cleanBranch = branch.trim() || session.branch || "branch未確定";
  return { repo: cleanRepo, branch: cleanBranch, raw };
}

function repoNameFromPath(repoPath: string): string {
  return basename(repoPath.replace(/[\\/]+$/, "")) || "repo";
}
