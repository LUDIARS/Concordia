/**
 * セッションの作業ツリーから HEAD と未コミット変更を読む。読めなければ null (指紋には「読めなかった」として入る)。
 *
 * @implements spec/feature/autonomous-work-continuation.md §2
 */
import type { SessionRow } from "../shared/types.js";

export interface ActivityGitResult { ok: boolean; stdout: string }
export type ActivityGitRunner = (cwd: string, args: string[]) => Promise<ActivityGitResult>;

export interface ObservedGitActivity { head: string | null; worktree: string | null }

export async function observeGitActivity(
  git: ActivityGitRunner, session: Pick<SessionRow, "repo_path">,
): Promise<ObservedGitActivity> {
  if (!session.repo_path) return { head: null, worktree: null };
  const read = async (args: string[]): Promise<string | null> => {
    try {
      const result = await git(session.repo_path, args);
      return result.ok ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  const [head, worktree] = await Promise.all([read(["rev-parse", "HEAD"]), read(["status", "--porcelain"])]);
  return { head: head || null, worktree };
}
