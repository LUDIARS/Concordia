/**
 * ws-cleanup — ワークスペース (E:/Document/Ars 配下のローカルクローン群) を安全に整理する。
 *
 * やること:
 *  1. worktree の掃除   … `git worktree prune` (= 既に消えた worktree の admin 記録を除去。 非破壊)
 *  2. main を最新化     … 既定ブランチを origin に ff 追従 (clean な時のみ。 reset --hard は使わない)
 *  3. 不要ブランチ整理  … 「作業中でない」 main 以外のローカルブランチのうち、
 *       - 既定ブランチに ff マージ済み (ancestor)          → `git branch -d` で削除 (安全)
 *       - PR マージ後に origin 側ブランチが消えた残骸       → `git branch -D` で削除 (任意 / 既定 ON)
 *     を片付ける。
 *  4. 判断保留を出力   … 未マージで origin が健在 / 未コミット変更あり / 別ブランチ作業中 /
 *       既存の追加 worktree / 既定ブランチ不明 などは触らず、 ユーザ判断用に列挙する。
 *
 * 破壊的操作を含むため、 既定は dry-run (apply=false)。 apply=true で初めて変更する。
 * git 実行は注入可能 (テストで fake / 実 git の両方を回せる)。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanReposMulti, type RepoStatus } from "../work/repo-scan.js";
import type { SessionsRepo } from "../db/sessions-repo.js";

const execFileAsync = promisify(execFile);
const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/** cwd で git を実行する関数 (非 throw、 失敗は ok=false)。 注入可能。 */
export type GitRunner = (cwd: string, args: string[]) => Promise<GitRunResult>;

export const defaultGitRunner: GitRunner = async (cwd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(GIT_BIN, ["-C", cwd, ...args], {
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      // 認証が要るリポへの fetch 等で対話プロンプトが出てハングするのを防ぐ (即失敗させる)。
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
};

export interface WsCleanupOptions {
  /** false = dry-run (既定)。 true で実際に変更する。 */
  apply: boolean;
  /** origin から fetch --prune するか (既定 true)。 状態判定の精度に効く。 */
  fetch?: boolean;
  /** PR マージ後に origin が消えた残ブランチを -D で削除するか (既定 true)。 */
  deleteMergedRemoteGone?: boolean;
}

export interface RepoCleanupReport {
  name: string;
  path: string;
  default_branch: string | null;
  current_branch: string | null;
  /** 実行 (apply) または予定 (dry-run) の安全アクション。 */
  actions: string[];
  /** 触らずユーザ判断に委ねる事項 (未マージ / 作業中 / 不明 等)。 */
  deferred: string[];
  error: string | null;
}

export interface WsCleanupResult {
  apply: boolean;
  repos: RepoCleanupReport[];
  summary: { repos: number; actions: number; deferred: number; errors: number };
}

export type BranchVerdict =
  | { kind: "delete-merged"; reason: string }
  | { kind: "delete-remote-gone"; reason: string }
  | { kind: "defer-in-use"; reason: string }
  | { kind: "defer-unmerged"; reason: string };

/**
 * 1 ブランチの処分判定 (純粋)。 git 実行結果から組み立てた事実だけで決める。
 */
export function classifyBranch(facts: {
  branch: string;
  inUse: boolean;
  inUseReason?: string;
  mergedAncestor: boolean;
  hasUpstream: boolean;
  remoteGone: boolean;
  ahead: number;
}): BranchVerdict {
  if (facts.inUse) {
    return { kind: "defer-in-use", reason: `作業中: ${facts.branch}${facts.inUseReason ? ` (${facts.inUseReason})` : ""}` };
  }
  if (facts.mergedAncestor) {
    return { kind: "delete-merged", reason: `マージ済みブランチを削除: ${facts.branch}` };
  }
  if (facts.hasUpstream && facts.remoteGone) {
    return {
      kind: "delete-remote-gone",
      reason: `PR マージ後の残ブランチを削除 (origin 側削除済): ${facts.branch} (ローカル +${facts.ahead})`,
    };
  }
  return {
    kind: "defer-unmerged",
    reason: `未マージ: ${facts.branch} (既定ブランチより +${facts.ahead})${facts.hasUpstream ? " / origin 健在" : " / upstream 無し"} — マージ要否はユーザ判断`,
  };
}

async function listLocalBranches(git: GitRunner, path: string): Promise<string[]> {
  const r = await git(path, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function refExists(git: GitRunner, path: string, ref: string): Promise<boolean> {
  return (await git(path, ["show-ref", "--verify", "--quiet", ref])).ok;
}

/** 既定ブランチ名を決める。 scan の default_branch → local main/master の順。 */
async function resolveDefaultBranch(git: GitRunner, repo: RepoStatus): Promise<string | null> {
  if (repo.default_branch) return repo.default_branch;
  for (const cand of ["main", "master"]) {
    if (await refExists(git, repo.path, `refs/heads/${cand}`)) return cand;
  }
  return null;
}

/** 1 リポの整理。 RepoStatus (scan 済) を起点に git 実 (or fake) を回す。 */
export async function cleanupRepo(
  repo: RepoStatus,
  opts: WsCleanupOptions,
  git: GitRunner,
): Promise<RepoCleanupReport> {
  const report: RepoCleanupReport = {
    name: repo.name,
    path: repo.path,
    default_branch: repo.default_branch,
    current_branch: repo.branch,
    actions: [],
    deferred: [],
    error: repo.error,
  };
  const doFetch = opts.fetch !== false;
  const allowRemoteGone = opts.deleteMergedRemoteGone !== false;

  if (repo.error) {
    report.deferred.push(`scan エラーのためスキップ: ${repo.error}`);
    return report;
  }

  // 0. fetch --prune (状態判定の精度向上。 working tree は変えない)。
  if (doFetch) {
    const f = await git(repo.path, ["fetch", "--prune", "origin"]);
    if (!f.ok) report.deferred.push(`git fetch 失敗 (オフライン?): ${oneLine(f.stderr)}`);
  }

  const def = await resolveDefaultBranch(git, repo);
  report.default_branch = def;
  if (!def) {
    report.deferred.push("既定ブランチを特定できない (origin/HEAD 未設定 + main/master 無し) — ユーザ判断");
  }

  // 1. worktree prune (消えた worktree の admin 記録だけ除去。 非破壊)。
  if (opts.apply) {
    const p = await git(repo.path, ["worktree", "prune"]);
    if (p.ok) report.actions.push("worktree prune 実行");
    else report.deferred.push(`worktree prune 失敗: ${oneLine(p.stderr)}`);
  } else {
    report.actions.push("worktree prune (予定)");
  }
  // 既存の追加 worktree は消さず列挙 (untracked データ消失を避ける)。
  for (const wt of repo.worktrees.filter((w) => !w.is_main)) {
    report.deferred.push(`追加 worktree 併存: ${wt.path} [${wt.branch ?? "detached"}] — 要否はユーザ判断`);
  }

  // 2. 既定ブランチを最新化。
  const dirty = await isDirty(git, repo.path);
  if (def && (await refExists(git, repo.path, `refs/remotes/origin/${def}`))) {
    const behind = await countRevs(git, repo.path, `${def}..origin/${def}`);
    if (behind > 0) {
      if (repo.branch === def) {
        if (dirty) {
          report.deferred.push(`${def} に未コミット変更あり — ff 更新を skip (破壊回避)`);
        } else if (opts.apply) {
          const m = await git(repo.path, ["merge", "--ff-only", `origin/${def}`]);
          if (m.ok) report.actions.push(`${def} を ff 更新 (+${behind})`);
          else report.deferred.push(`${def} ff 更新失敗 (分岐?): ${oneLine(m.stderr)}`);
        } else {
          report.actions.push(`${def} を ff 更新 (+${behind}) (予定)`);
        }
      } else {
        // 別ブランチ作業中: checkout せず ref だけ ff 前進 (memory: git fetch origin main:main)。
        if (opts.apply) {
          const r = await git(repo.path, ["fetch", "origin", `${def}:${def}`]);
          if (r.ok) report.actions.push(`${def} ref を ff 前進 (+${behind}、 checkout せず)`);
          else report.deferred.push(`${def} ref 前進失敗 (非 ff?): ${oneLine(r.stderr)}`);
        } else {
          report.actions.push(`${def} ref を ff 前進 (+${behind}) (予定)`);
        }
      }
    }
  } else if (def) {
    report.deferred.push(`origin/${def} が無く main 最新化をスキップ`);
  }

  // 3. ブランチ整理。
  if (def) {
    const inUse = inUseBranchSet(repo);
    const branches = await listLocalBranches(git, repo.path);
    for (const b of branches) {
      if (b === def) continue;
      const mergedAncestor = (await git(repo.path, ["merge-base", "--is-ancestor", b, def])).ok;
      // 追跡情報は branch config から読む。 `@{upstream}` は remote-tracking ref が
      // prune 済みだと解決できず「upstream 無し」に化けるため (= remote-gone を取り逃す)。
      const tracking = await trackingOf(git, repo.path, b);
      const remoteGone =
        tracking.hasUpstream && tracking.remoteRef !== null &&
        !(await refExists(git, repo.path, tracking.remoteRef));
      const ahead = await countRevs(git, repo.path, `${def}..${b}`);
      const verdict = classifyBranch({
        branch: b,
        inUse: inUse.has(b),
        inUseReason: inUse.get(b),
        mergedAncestor,
        hasUpstream: tracking.hasUpstream,
        remoteGone,
        ahead,
      });

      if (verdict.kind === "delete-merged") {
        await applyDelete(git, repo, b, ["branch", "-d", b], verdict.reason, opts.apply, report);
      } else if (verdict.kind === "delete-remote-gone") {
        if (!allowRemoteGone) {
          report.deferred.push(`${verdict.reason} (deleteMergedRemoteGone=false のため保留)`);
        } else {
          await applyDelete(git, repo, b, ["branch", "-D", b], verdict.reason, opts.apply, report);
        }
      } else {
        report.deferred.push(verdict.reason);
      }
    }
  }

  return report;
}

async function applyDelete(
  git: GitRunner,
  repo: RepoStatus,
  branch: string,
  args: string[],
  reason: string,
  apply: boolean,
  report: RepoCleanupReport,
): Promise<void> {
  if (!apply) {
    report.actions.push(`${reason} (予定)`);
    return;
  }
  const r = await git(repo.path, args);
  if (r.ok) report.actions.push(reason);
  else report.deferred.push(`ブランチ削除失敗 ${branch}: ${oneLine(r.stderr)}`);
}

/** 「作業中」とみなすブランチ集合 (active/lost session + 全 worktree の checkout 先)。 */
export function inUseBranchSet(repo: RepoStatus): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of repo.sessions) {
    if (s.status !== "ended" && s.branch) m.set(s.branch, `session ${s.id.slice(0, 8)} ${s.status}`);
  }
  for (const wt of repo.worktrees) {
    if (wt.branch && !m.has(wt.branch)) m.set(wt.branch, wt.is_main ? "現在ブランチ" : "worktree");
  }
  if (repo.branch && !m.has(repo.branch)) m.set(repo.branch, "現在ブランチ");
  return m;
}

async function isDirty(git: GitRunner, path: string): Promise<boolean> {
  const r = await git(path, ["status", "--porcelain"]);
  return r.ok ? r.stdout.trim().length > 0 : false;
}

async function countRevs(git: GitRunner, path: string, range: string): Promise<number> {
  const r = await git(path, ["rev-list", "--count", range]);
  if (!r.ok) return 0;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/** branch config (`branch.<b>.remote` / `.merge`) から追跡先 remote-tracking ref を求める。 */
async function trackingOf(
  git: GitRunner,
  path: string,
  branch: string,
): Promise<{ hasUpstream: boolean; remoteRef: string | null }> {
  const remote = (await git(path, ["config", "--get", `branch.${branch}.remote`])).stdout.trim();
  const merge = (await git(path, ["config", "--get", `branch.${branch}.merge`])).stdout.trim();
  if (!remote || !merge) return { hasUpstream: false, remoteRef: null };
  const short = merge.replace(/^refs\/heads\//, "");
  return { hasUpstream: true, remoteRef: `refs/remotes/${remote}/${short}` };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * 全ルートを走査して整理する。 linked worktree / scan エラーのエントリは
 * 親リポ経由で扱うためスキップ (worktree 自身に対する branch 操作は避ける)。
 */
export async function runWsCleanup(
  roots: string[],
  sessionsRepo: SessionsRepo,
  opts: WsCleanupOptions,
  git: GitRunner = defaultGitRunner,
): Promise<WsCleanupResult> {
  const all = await scanReposMulti(roots, sessionsRepo);
  const targets = all.filter((r) => !r.is_worktree);
  const reports = await mapLimit(targets, 4, (r) => cleanupRepo(r, opts, git));

  const summary = reports.reduce(
    (acc, r) => ({
      repos: acc.repos + 1,
      actions: acc.actions + r.actions.length,
      deferred: acc.deferred + r.deferred.length,
      errors: acc.errors + (r.error ? 1 : 0),
    }),
    { repos: 0, actions: 0, deferred: 0, errors: 0 },
  );

  return { apply: opts.apply, repos: reports, summary };
}

/** 並行度を絞って map (fetch のネットワーク負荷を抑える)。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
