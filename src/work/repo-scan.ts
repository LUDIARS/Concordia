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
import { existsSync } from "node:fs";
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
  worktrees: RepoWorktree[];
  /** main 以外の worktree 数 (= 別ブランチ並行作業の本数). */
  extra_worktree_count: number;
  /** この repo / その worktree を触っている session (best effort). */
  sessions: RepoSessionRef[];
  error: string | null;
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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

  // この repo に属する path 集合 (本体 + 全 worktree) に repo_path が一致する session を拾う.
  const owned = new Set<string>([normPath(path), ...worktrees.map((w) => normPath(w.path))]);
  const sessions: RepoSessionRef[] = allSessions
    .filter((s) => owned.has(normPath(s.repo_path)))
    .map((s) => ({ id: s.id, branch: s.branch, status: s.status, current_task: s.current_task }));

  return {
    name,
    path,
    branch,
    detached,
    worktrees,
    extra_worktree_count: Math.max(0, worktrees.length - 1),
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
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}
