/**
 * 「人間の応答待ちの確認」を解く判定 (human-response-activity-release.ts) の入力を集める。
 * git の HEAD とコミット時刻、そのセッションの審査中 PR を読む。読めない項目は null。
 *
 * @implements spec/feature/human-response-confirmation.md
 */
import type { ConfirmationActivity } from "../control/human-response-activity-release.js";
import type { RevisorLocalPr } from "../pr/revisor-local-pr-types.js";
import type { SessionRow } from "../shared/types.js";
import type { ReaperGitRunner } from "./reaper-facts.js";
import { openPrForSession } from "./review-status-source.js";

async function headOf(git: ReaperGitRunner, session: SessionRow): Promise<{ head: string; at: number } | null> {
  try {
    const result = await git(session.repo_path, ["log", "-1", "--format=%H %ct"]);
    if (!result.ok) return null;
    const [head, at] = result.stdout.trim().split(/\s+/);
    const committedAt = Number(at);
    return head && /^[0-9a-f]{7,64}$/i.test(head) && Number.isFinite(committedAt) ? { head, at: committedAt } : null;
  } catch {
    return null;
  }
}

export async function observeConfirmationActivity(
  git: ReaperGitRunner, session: SessionRow, openPrs: readonly RevisorLocalPr[] | null,
): Promise<ConfirmationActivity> {
  const head = await headOf(git, session);
  const pr = openPrs ? openPrForSession(openPrs, session) : null;
  return {
    head: head?.head ?? null,
    headCommittedAt: head?.at ?? null,
    prs: openPrs === null ? null : pr ? [`${pr.number}:${pr.headSha}`] : [],
  };
}
