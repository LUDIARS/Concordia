/**
 * Validate a delegation spawn cwd before Lictor is launched.
 *
 * 2026-09-05 障害: 委託 run が `cwd: E:/Document/Ars/.wt-Quaestor-mail-realtime`
 * (実在しないディレクトリ) で spawn され、 wt.exe の `-d` が効かずに cwd が
 * 親を辿って共有 checkout (Castra root, main) へ着地した。 委託先は「共有
 * checkout に触るな」と指示されていたにも関わらず、 そこへ直接コミットした。
 *
 * 原因は prepareSpawnTarget が branch 未指定のとき cwd を素通ししていたこと。
 * git 検証は branch 経路の内側にしか無く、 cwd が実在するかすら見ていなかった。
 * ここでは branch の有無と無関係に cwd を検証し、 使えない cwd では spawn を
 * 中止する (黙って別の場所で作業させない)。
 *
 * 「実在しない cwd は spawn 中止」が本質。 git checkout であることまでは常に
 * 要求しない — テンプレの `${target_repo}` が解決できないときに workspace root へ
 * 落とす経路 (複数リポ横断の作業) は正当で、 workspace root は repo とは限らない。
 * git checkout を要求するのは branch/worktree を用意する必要があるとき (repoRoot を
 * 実際に使うとき) だけにする。
 *
 * 事故の別型である「空の .wt-* ディレクトリだけが残っている」 は、 branch を構造化
 * フィールドで渡していない時点で branch-source 側 (delegation/branch-source.ts) が
 * 止めるため、 ここで重ねて縛らない。
 */

import { statSync } from "node:fs";

/** cwd 検証に使う git ランナー。 spawn-target と同じ形にして差し替え可能にする。 */
export type SpawnCwdGitRunner = (cwd: string, args: string[]) => Promise<string>;

export interface SpawnCwdOk {
  ok: true;
  /** 検証した cwd。 未指定なら undefined (wt が user-home で開く既定動作)。 */
  cwd?: string;
  /** cwd を含む git checkout の root。 cwd 未指定なら null。 */
  repoRoot: string | null;
}

export interface SpawnCwdErr {
  ok: false;
  error: string;
}

export type SpawnCwdResult = SpawnCwdOk | SpawnCwdErr;

export interface ValidateSpawnCwdInput {
  cwd?: string;
  git: SpawnCwdGitRunner;
  /** true = git checkout であることも必須にする (branch/worktree を用意する場合)。 */
  requireGitCheckout?: boolean;
}

/**
 * cwd が spawn 先として使えるかを確かめる。
 *
 * - cwd 未指定 → ok (呼び出し元が場所を指定していない = 既定動作に委ねる)
 * - 実在しない / ディレクトリでない → error (branch の有無に関わらず)
 * - git checkout の中でない → `requireGitCheckout` のときだけ error。 それ以外は
 *   repoRoot を null にして通す
 */
export async function validateSpawnCwd(input: ValidateSpawnCwdInput): Promise<SpawnCwdResult> {
  const cwd = input.cwd?.trim() || undefined;
  if (!cwd) return { ok: true, cwd: undefined, repoRoot: null };

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(cwd);
  } catch {
    return { ok: false, error: `spawn cwd does not exist: ${cwd}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `spawn cwd is not a directory: ${cwd}` };
  }

  let repoRoot = "";
  try {
    repoRoot = (await input.git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (input.requireGitCheckout) {
      return { ok: false, error: `spawn cwd is not a git checkout: ${cwd} (${messageOf(error)})` };
    }
  }
  if (!repoRoot && input.requireGitCheckout) {
    return { ok: false, error: `spawn cwd is not a git checkout: ${cwd}` };
  }
  return { ok: true, cwd, repoRoot: repoRoot || null };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
