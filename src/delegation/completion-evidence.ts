import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  collectAugurAcceptance,
  hasAcceptanceContract,
  resolveAugurCliPath,
  type AugurRunner,
} from "./augur-acceptance.js";
import { formatUnmetAcceptance, reconcileAcceptance, type ReportedAcceptanceItem } from "./acceptance-reconcile.js";

export interface CompletionEvidenceRun {
  spawn_cwd?: string | null;
  spawn_worktree_path?: string | null;
  spawn_branch?: string | null;
  /** 委託開始時刻 (epoch-ms)。 Augur 集計の `--since` に使う。 */
  created_at?: number | null;
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
  /** 完了報告の自己申告。 契約ファイルがある run はこれを Augur の集計と突合する。 */
  acceptanceReport?: readonly ReportedAcceptanceItem[] | null;
  /** Augur CLI 解決に使うワークスペースルート群 (既定は env のみで解決)。 */
  workspaceRoots?: readonly string[];
  /** Augur 実行の差し替え (テスト用)。 */
  augurRunner?: AugurRunner;
  /** 契約ファイル検出の差し替え (テスト用)。 */
  hasContract?: (dir: string) => boolean;
  /** Augur CLI パス解決の差し替え (テスト用)。 null = 解決不能。 */
  resolveAugurCli?: (workspaceRoots: readonly string[]) => string | null;
  env?: NodeJS.ProcessEnv;
}

export type CompletionEvidenceVerdict =
  | { ok: true; checked: false }
  | { ok: true; checked: true }
  | { ok: false; reason: string };

const execFileAsync = promisify(execFile);
const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";
const GIT_TIMEOUT_MS = 30_000;
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
  options: CompletionEvidenceOptions = {},
): Promise<CompletionEvidenceVerdict> {
  const { reviewOnly = false } = options;
  if (reviewOnly) return { ok: true, checked: false };
  const cwd = run.spawn_worktree_path ?? run.spawn_cwd;
  if (!cwd) return { ok: true, checked: false };
  if (!existsSync(cwd) || !existsSync(join(cwd, ".git"))) {
    return { ok: false, reason: "spawned checkout is missing or is not a Git worktree" };
  }
  if (!run.spawn_branch) {
    // The API has a legacy merged-PR fallback for branchless child runs. Check
    // contracts before returning that branch verdict so the fallback cannot
    // bypass an acceptance mismatch.
    const acceptance = await verifyContractAcceptance(cwd, run, options);
    if (!acceptance.ok) return acceptance;
    return { ok: false, reason: "spawned checkout has no recorded feature branch" };
  }

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
  return verifyContractAcceptance(cwd, run, options);
}

/**
 * 契約書式の受け入れ条件を Augur の集計で突合する。
 *
 * 実行するのは受託側と同じ集計 (`contracts report --project <wt> --acceptance --json
 * --since <run 作成時刻>`)。 コマンドの組み立てと実行は augur-acceptance.ts、 突合は
 * acceptance-reconcile.ts が持ち、 ここは completed 判定への組み込みだけを持つ。
 *
 * 契約ファイル (`augur.contracts.json`) が worktree に無い委託は従来どおり branch 証跡
 * だけで通す。 契約ファイルがある委託は、 自己申告 `met` と集計の食い違いを
 * `unmet acceptance` として completed を拒否する。
 *
 * 契約ファイルがあるのに Augur を実行できない (CLI が無い / 実行が落ちる / JSON が壊れて
 * いる) 場合も**拒否する**。 「証跡を取れなかったから通す」にすると、 契約を置いた委託ほど
 * 検証を素通りできてしまい、 このガードが自分の目的を裏切る。 診断は理由文へ出して、
 * 人が env `CONCORDIA_AUGUR_DIR` の設定なり再実行なりを選べるようにする。
 */
export async function verifyContractAcceptance(
  cwd: string,
  run: CompletionEvidenceRun,
  options: CompletionEvidenceOptions = {},
): Promise<CompletionEvidenceVerdict> {
  const hasContract = options.hasContract ?? hasAcceptanceContract;
  if (!hasContract(cwd)) return { ok: true, checked: true };

  const workspaceRoots = options.workspaceRoots ?? [];
  const cliPath = options.resolveAugurCli
    ? options.resolveAugurCli(workspaceRoots)
    : resolveAugurCliPath({ env: options.env ?? process.env, workspaceRoots });
  if (!cliPath) {
    return {
      ok: false,
      reason: "acceptance contract present but the Augur CLI could not be resolved (set CONCORDIA_AUGUR_DIR)",
    };
  }
  if (typeof run.created_at !== "number" || !Number.isFinite(run.created_at)) {
    return { ok: false, reason: "acceptance contract present but the delegation start time is unavailable" };
  }
  const startedAt = new Date(run.created_at);
  if (Number.isNaN(startedAt.getTime())) {
    return { ok: false, reason: "acceptance contract present but the delegation start time is invalid" };
  }
  const since = startedAt.toISOString();
  let aggregated;
  try {
    aggregated = await collectAugurAcceptance({
      cliPath,
      projectDir: cwd,
      since,
      runner: options.augurRunner,
    });
  } catch {
    // execFile errors may include local paths, command lines, or stderr. The
    // verdict is persisted and relayed to a parent session, so keep it stable
    // and non-sensitive while still identifying the failed boundary.
    return { ok: false, reason: "acceptance contract present but the Augur report execution or parsing failed" };
  }
  const unmet = reconcileAcceptance(options.acceptanceReport ?? [], aggregated);
  if (unmet.length > 0) return { ok: false, reason: formatUnmetAcceptance(unmet) };
  return { ok: true, checked: true };
}
