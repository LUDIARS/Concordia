/**
 * ワークスペース直下 (E:\Document\Ars) のローカルクローンを走査し、
 * 各リポの「現在ブランチ / worktree / 触っている session」を集める.
 *
 * Work ページ用. git 実行 + fs 走査は best-effort (失敗してもそのリポだけ error に
 * 入れて他は返す). worktree 由来の session も親リポに紐づけて表示する.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";

const execFileAsync = promisify(execFile);
const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";

export interface RepoWorktree {
  path: string;
  branch: string | null;
  is_main: boolean;
}

export interface RepoSessionRef {
  id: string;
  branch: string | null;
  status: string;
  current_task: string | null;
}

export interface RepoStatus {
  name: string;
  path: string;
  /** main worktree の現在ブランチ (detached なら null). */
  branch: string | null;
  detached: boolean;
  /**
   * このフォルダ自身が linked worktree か (`.git` がファイル = gitdir 参照).
   * worktree は既定ブランチに居ないのが正常なので赤枠判定から除外し緑枠にする.
   */
  is_worktree: boolean;
  /** リポの既定ブランチ (origin/HEAD 由来、 取れなければ null). */
  default_branch: string | null;
  /** 現在ブランチが既定ブランチ (main/master 等) と一致するか. */
  on_default_branch: boolean;
  worktrees: RepoWorktree[];
  /** main 以外の worktree 数 (= 別ブランチ並行作業の本数). */
  extra_worktree_count: number;
  /** HEAD の最終コミット時刻 (epoch 秒、 取れなければ null). 最終更新順ソートに使う. */
  updated_at: number | null;
  /** この repo / その worktree を触っている session (best effort). */
  sessions: RepoSessionRef[];
  error: string | null;
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * フォルダが linked worktree か (pure に近い fs 判定). main clone は `.git` が
 * ディレクトリ、 linked worktree は `gitdir: ...` を書いた **ファイル**。 stat 失敗は
 * worktree でない扱い (best-effort).
 */
function isLinkedWorktree(repoPath: string): boolean {
  try {
    return statSync(join(repoPath, ".git")).isFile();
  } catch {
    return false;
  }
}

/**
 * 現在ブランチが既定ブランチ上にあるか (pure). 既定ブランチが取れていれば
 * それと厳密一致、 取れていなければ main / master を既定とみなす fallback.
 * detached (branch=null) は常に false.
 */
export function isOnDefaultBranch(branch: string | null, defaultBranch: string | null): boolean {
  if (branch === null) return false;
  if (defaultBranch) return branch === defaultBranch;
  return branch === "main" || branch === "master";
}

/** active 状態の session 数 (pure). 2 以上 = 競合の疑いで最上位ハイライト対象. */
export function activeSessionCount(repo: Pick<RepoStatus, "sessions">): number {
  return repo.sessions.filter((s) => s.status === "active").length;
}

/**
 * Work 一覧のソート比較 (pure). 優先順位:
 *   1. active session が 2 つ以上ある repo を最上位 (競合の疑い → 目立たせる)
 *   2. 最終更新 (updated_at) 降順 (null は末尾)
 *   3. 名前順 (安定化)
 */
export function compareByActivity(a: RepoStatus, b: RepoStatus): number {
  const aMulti = activeSessionCount(a) >= 2 ? 1 : 0;
  const bMulti = activeSessionCount(b) >= 2 ? 1 : 0;
  if (aMulti !== bMulti) return bMulti - aMulti; // multi-active を先頭へ

  const at = a.updated_at;
  const bt = b.updated_at;
  if (at !== bt) {
    if (at === null) return 1;
    if (bt === null) return -1;
    return bt - at; // 新しいものが先
  }
  return a.name.localeCompare(b.name);
}

/** `git worktree list --porcelain` の stdout を parse (pure). 先頭が main worktree. */
export function parseWorktreeList(stdout: string): RepoWorktree[] {
  const out: RepoWorktree[] = [];
  let cur: { path?: string; branch?: string | null } = {};
  const flush = () => {
    if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? null, is_main: false });
    cur = {};
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      flush();
      cur.path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      cur.branch = null;
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return out.map((w, i) => ({ ...w, is_main: i === 0 }));
}

async function git(path: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(GIT_BIN, ["-C", path, ...args], {
    timeout: 8_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function scanOne(name: string, path: string, allSessions: SessionRow[]): Promise<RepoStatus> {
  let branch: string | null = null;
  let detached = false;
  let worktrees: RepoWorktree[] = [];
  let defaultBranch: string | null = null;
  let updatedAt: number | null = null;
  let error: string | null = null;

  try {
    const b = (await git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (b === "HEAD") detached = true;
    else branch = b;
  } catch (e) {
    error = (e as Error).message;
  }
  try {
    worktrees = parseWorktreeList(await git(path, ["worktree", "list", "--porcelain"]));
  } catch {
    /* worktree 取得失敗は致命ではない (branch だけ出す) */
  }
  try {
    // origin/HEAD → "origin/main" 等。 set されていないリポでは失敗するので fallback。
    const ref = (await git(path, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
    defaultBranch = ref.replace(/^origin\//, "") || null;
  } catch {
    /* origin/HEAD 未設定 → isOnDefaultBranch の main/master fallback に委ねる */
  }
  try {
    // 最終更新順ソート用。 HEAD の commit time (epoch 秒)。
    const ct = (await git(path, ["log", "-1", "--format=%ct", "HEAD"])).trim();
    const n = Number(ct);
    if (Number.isFinite(n) && n > 0) updatedAt = n;
  } catch {
    /* コミットが無い等。 updated_at=null は末尾ソート */
  }

  // この repo に属する path 集合 (本体 + 全 worktree) に repo_path が一致する session を拾う.
  // 終了 (ended) session は Work 上で表示不要なので除外する。
  const owned = new Set<string>([normPath(path), ...worktrees.map((w) => normPath(w.path))]);
  const sessions: RepoSessionRef[] = allSessions
    .filter((s) => owned.has(normPath(s.repo_path)) && s.status !== "ended")
    .map((s) => ({ id: s.id, branch: s.branch, status: s.status, current_task: s.current_task }));

  return {
    name,
    path,
    branch,
    detached,
    is_worktree: isLinkedWorktree(path),
    default_branch: defaultBranch,
    on_default_branch: isOnDefaultBranch(branch, defaultBranch),
    worktrees,
    extra_worktree_count: Math.max(0, worktrees.length - 1),
    updated_at: updatedAt,
    sessions,
    error,
  };
}

/** rootDir 直下の git リポを走査して RepoStatus[] を返す (名前順). */
export async function scanRepos(rootDir: string, sessionsRepo: SessionsRepo): Promise<RepoStatus[]> {
  if (!rootDir || !existsSync(rootDir)) return [];
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return [];
  }
  const allSessions = sessionsRepo.listSessions({});
  const repoDirs = entries
    .map((name) => ({ name, path: join(rootDir, name) }))
    .filter((d) => existsSync(join(d.path, ".git")));
  const results = await Promise.all(repoDirs.map((d) => scanOne(d.name, d.path, allSessions)));
  // active 2+ を最上位 → 最終更新降順 → 名前順 (compareByActivity)。
  results.sort(compareByActivity);
  return results;
}
