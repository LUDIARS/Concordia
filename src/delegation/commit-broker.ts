// 委託 run のコミット代行 (spec/feature/delegation.md §14)。 guard (commit-guard.ts) を
// 通したうえで git を叩く。
//
// 背景と責務分担は commit-guard.ts の冒頭を参照。 ここは I/O 担当で、
// 判定ロジックは持たない。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { checkCommitAllowed, type CommitGuardRejection } from "./commit-guard.js";
import { readCommitRequest, removeCommitRequest, type CommitRequest } from "./commit-request.js";

const execFileAsync = promisify(execFile);
const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";
const GIT_TIMEOUT_MS = 30_000;

/**
 * コミット代行に必要な run の情報だけを受ける。 DelegationRunRow をそのまま
 * 受けないのは、 このモジュールを repo 層に依存させないため (テストも楽になる)。
 */
export interface CommitTargetRun {
  id: string;
  spawn_cwd?: string | null;
  spawn_branch?: string | null;
  target_provider?: string | null;
}

export type CommitOutcome =
  | { ok: true; sha: string; files: number }
  | { ok: false; code: CommitGuardRejection | "git_failed" | "invalid_request"; detail: string };

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(GIT_BIN, ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/**
 * ワークスペースルート (= リポジトリの集合を置いてある親)。 Concordia は
 * `<workspace>/Concordia` で動くので、 その親が既定。 env で上書きできる。
 */
function workspaceRoots(): string[] {
  const configured = process.env.CONCORDIA_COMMIT_FORBIDDEN_ROOTS;
  if (configured) return configured.split(";").map((p) => p.trim()).filter(Boolean);
  return [resolve(process.cwd(), "..")];
}

/** `git status --porcelain -uall` の出力から変更パスを取り出す (export はテスト用)。 */
export function parseChangedPaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    // 「XY <path>」。 rename は "R  old -> new" なので新しい方を採る。
    .map((line) => {
      const path = line.slice(3);
      const arrow = path.indexOf(" -> ");
      return arrow >= 0 ? path.slice(arrow + 4) : path;
    })
    .map((path) => path.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function buildMessage(request: CommitRequest, run: CommitTargetRun): string {
  const trailers = [`Delegated-Run: ${run.id}`];
  if (run.target_provider) trailers.push(`Delegated-Provider: ${run.target_provider}`);
  return `${request.message.trim()}\n\n${trailers.join("\n")}\n`;
}

/**
 * run が所有する worktree をコミットする。 検証に落ちたら理由付きで false を返し、
 * git には触れない。 push はしない (公開は local PR 経路の責務)。
 */
export async function commitForRun(
  run: CommitTargetRun,
  request: CommitRequest,
): Promise<CommitOutcome> {
  if (!run.spawn_cwd) {
    return { ok: false, code: "run_cwd_unknown", detail: "this run has no spawn_cwd" };
  }
  const cwd: string = run.spawn_cwd;

  let repoRoot: string;
  let currentBranch: string;
  let changedPaths: string[];
  try {
    repoRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    currentBranch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    // `-uall` が要る: 既定の porcelain は未追跡ディレクトリを `dir/` 1 行に畳むので、
    // 数千ファイルの新規ディレクトリが「変更 1 件」 に見えて too_many_changes を素通りする。
    // `git add -A` は畳まれた中身を全部 stage するため、 数え方を stage 対象に揃える。
    changedPaths = parseChangedPaths(await git(cwd, ["status", "--porcelain", "-uall"]));
  } catch (error) {
    return { ok: false, code: "git_failed", detail: describeError(error) };
  }

  const verdict = checkCommitAllowed({
    runCwd: cwd,
    runBranch: run.spawn_branch ?? null,
    repoRoot,
    currentBranch,
    changedPaths,
    forbiddenRoots: workspaceRoots(),
  });
  if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail };

  // 依頼ファイル自体はコミットに含めない。 `git add -A` は cwd 直下の
  // `.concordia-commit.json` も拾うので、 stage 前に消しておかないと
  // 「依頼が履歴に残り、 その後の unlink で worktree が dirty のまま」 になる。
  await removeCommitRequest(cwd);

  try {
    // hooks はそのまま走らせる (--no-verify は使わない)。
    if (request.paths && request.paths.length > 0) {
      await git(cwd, ["add", "--", ...request.paths]);
    } else {
      await git(cwd, ["add", "-A"]);
    }
    const staged = (await git(cwd, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
    if (staged.length === 0) {
      return { ok: false, code: "nothing_to_commit", detail: "nothing was staged" };
    }
    await git(cwd, ["commit", "-m", buildMessage(request, run)]);
    const sha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    return { ok: true, sha, files: staged.length };
  } catch (error) {
    return { ok: false, code: "git_failed", detail: describeError(error) };
  }
}

/**
 * cwd に置かれた依頼ファイルがあればコミットする。 run 終了時の掃き出しに使う。
 * 依頼が無ければ null (= 何もしない、 正常系)。
 */
export async function commitFromRequestFile(run: CommitTargetRun): Promise<CommitOutcome | null> {
  if (!run.spawn_cwd) return null;
  const read = await readCommitRequest(run.spawn_cwd);
  if (read.kind === "none") return null;
  if (read.kind === "invalid") {
    // 依頼はあったが形が違う。 消さずに残すと後続 run の `git add -A` が拾ってしまうので
    // 消したうえで、 拒否理由を委託元に返す (黙って捨てない)。
    await removeCommitRequest(run.spawn_cwd);
    return { ok: false, code: "invalid_request", detail: read.detail };
  }

  const outcome = await commitForRun(run, read.request);
  // commitForRun は stage 前に消すが、 guard 拒否で そこまで届かない経路がある。
  // 失敗しても消す — 残すと同じ依頼で毎回失敗し続けるため
  // (理由は呼び出し側がログ / run.error に残す)。
  await removeCommitRequest(run.spawn_cwd);
  return outcome;
}

function describeError(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr.slice(0, 2_000);
  }
  return error instanceof Error ? error.message : String(error);
}
