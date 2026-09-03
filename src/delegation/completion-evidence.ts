import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export interface CompletionEvidenceRun {
  spawn_cwd?: string | null;
  spawn_worktree_path?: string | null;
  spawn_branch?: string | null;
}

/**
 * feature branch を成果物として要求してよい run か。
 *
 * パートタイマー (定時起動) は成果がコードではない — メール取り込み、カタログ更新、
 * 依存点検の報告、朝礼投稿。 テンプレ本文が「commit も push も PR もしない」と明記して
 * いるものすらある。 それでも default_cwd に対象リポを持つので、 このガードが
 * 「spawned checkout has no recorded feature branch」で completed を failed に落として
 * いた (2026-09-02〜03 の quaestor-mail-sweep / kaizen-daily / deps-sweep-daily /
 * vulnerability-response-daily の failed は全部これ)。 実装委託の自己申告を疑うための
 * ガードなので、 実装委託でない run は対象外にする。
 */
export function requiresCompletionEvidence(category: string | null | undefined): boolean {
  return category !== "parttimer";
}

export interface CompletionEvidenceOptions {
  /**
   * テンプレートが「コードを書かない」と宣言している run。 成果物が feature branch では
   * ないので、 branch 証跡を要求しない。 run 側の状態ではなくテンプレート定義から来る
   * ことが重要で、 実装テンプレの run が branch を持たないまま素通りする穴は残さない。
   */
  reviewOnly?: boolean;
}

export type CompletionEvidenceVerdict =
  | { ok: true; checked: false }
  | { ok: true; checked: true }
  | { ok: false; reason: string };

const execFileAsync = promisify(execFile);
const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";
const GIT_TIMEOUT_MS = 5_000;
const PROTECTED_BRANCHES = new Set(["main", "develop"]);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(GIT_BIN, ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function countCommitsSinceBase(cwd: string): Promise<number> {
  const counts = await Promise.all(["develop", "main"].map(async (base): Promise<number | null> => {
    try {
      const baseRef = `refs/heads/${base}`;
      const count = await git(cwd, ["rev-list", "--count", "HEAD", `^${baseRef}`]);
      return /^\d+$/.test(count) ? Number(count) : null;
    } catch {
      // Either base may be absent. The other declared base is still valid evidence.
      return null;
    }
  }));
  // A repository may contain both diverged bases. The nearest base is the one
  // that avoids counting unrelated main/develop commits as feature evidence.
  const availableCounts = counts.filter((count): count is number => count !== null);
  return availableCounts.length > 0 ? Math.min(...availableCounts) : 0;
}

/**
 * Verifies a spawned checkout before accepting an agent's self-reported completion.
 * Runs without a checkout are intentionally outside this guard because they cannot
 * be attributed to a branch-owned implementation worktree.
 *
 * A template that declares itself review-only is outside the guard for the same
 * reason: its deliverable is a report, not a branch. The declaration lives on the
 * template rather than being inferred from a missing branch, because inferring it
 * would re-open the hole this guard exists to close — an implementation run that
 * never checked out a branch claiming completion.
 */
export async function verifyCompletionEvidence(
  run: CompletionEvidenceRun,
  { reviewOnly = false }: CompletionEvidenceOptions = {},
): Promise<CompletionEvidenceVerdict> {
  if (reviewOnly) return { ok: true, checked: false };
  const cwd = run.spawn_worktree_path ?? run.spawn_cwd;
  if (!cwd) return { ok: true, checked: false };
  if (!existsSync(cwd) || !existsSync(join(cwd, ".git"))) {
    return { ok: false, reason: "spawned checkout is missing or is not a Git worktree" };
  }
  if (!run.spawn_branch) return { ok: false, reason: "spawned checkout has no recorded feature branch" };

  let branch: string;
  try {
    branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return { ok: false, reason: "spawned checkout Git metadata could not be read" };
  }
  if (branch === "HEAD" || branch !== run.spawn_branch || PROTECTED_BRANCHES.has(branch)) {
    return { ok: false, reason: "spawned checkout is not on its recorded non-protected feature branch" };
  }
  if (await countCommitsSinceBase(cwd) < 1) {
    return { ok: false, reason: "spawned feature branch has no commit beyond main or develop" };
  }
  return { ok: true, checked: true };
}
