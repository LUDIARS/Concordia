// 委託先が置く「コミットしてほしい」 依頼ファイルの読み書き
// (spec/feature/delegation.md §14 の 2 番目の経路)。
//
// HTTP (`POST /v1/delegation/runs/:id/commit`) が使えるならそちらが速いが、
// サンドボックス下のエージェントは loopback を塞がれていることがある。 一方
// `workspace-write` の性質上 **ワークスペース内のファイル書き込みだけは必ず通る**
// ので、 依頼ファイルを最後の退避路として用意する。

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/** 委託先が cwd 直下に置くファイル名。 */
export const COMMIT_REQUEST_FILENAME = ".concordia-commit.json";

export interface CommitRequest {
  /** コミットメッセージ (1 行目 = 件名)。 */
  message: string;
  /** 省略時は worktree の全変更。 指定時はそのパスだけ stage する。 */
  paths?: string[];
}

const MAX_MESSAGE_LENGTH = 8_000;
const MAX_PATHS = 200;

/**
 * 依頼の形。 拒否したときの理由として HTTP 経路と依頼ファイル経路の両方で使う。
 * `parseCommitRequest` は null を返すだけなので、 これを添えないと委託先は
 * 「どの規則で落ちたのか」 が分からず直しようがない (無言拒否禁止 — coding-conventions §6)。
 */
export const COMMIT_REQUEST_SHAPE_HINT =
  '{"message": string, "paths"?: string[] — cwd 相対のリテラルなパスのみ (絶対パス / ".." / 先頭 ":" は不可)}';

/** 依頼の形を検証する。 不正なら null (呼び出し側が理由付きで拒否する)。 */
export function parseCommitRequest(raw: unknown): CommitRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as { message?: unknown; paths?: unknown };

  const message = typeof candidate.message === "string" ? candidate.message.trim() : "";
  if (!message || message.length > MAX_MESSAGE_LENGTH) return null;

  if (candidate.paths === undefined || candidate.paths === null) return { message };

  if (!Array.isArray(candidate.paths) || candidate.paths.length > MAX_PATHS) return null;
  const paths: string[] = [];
  for (const entry of candidate.paths) {
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    // 絶対パスと親参照は受けない。 stage 対象は run の worktree 内に限る。
    if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("\\")) return null;
    if (/^[A-Za-z]:/.test(trimmed)) return null;
    if (trimmed.split(/[\\/]/).includes("..")) return null;
    // 先頭 `:` は git の pathspec magic (`:/`, `:(exclude)…`)。 `git add -- <path>` の
    // `--` はオプション解析を止めるだけで magic は生きるので、 ここで弾いて
    // 「paths は cwd 相対のリテラルなパス」 という約束を実際に成り立たせる。
    if (trimmed.startsWith(":")) return null;
    paths.push(trimmed);
  }
  return paths.length > 0 ? { message, paths } : { message };
}

/**
 * 依頼ファイルの読み取り結果。 「無い」 と 「壊れている」 を分ける:
 * 前者は正常系 (大半の run は自分でコミットできる) だが、 後者は委託先が
 * 依頼を出したのに形が違う状態で、 黙って捨てると委託元が永久に気付けない
 * (coding-conventions §6 — 無言フォールバック禁止)。
 */
export type CommitRequestRead =
  | { kind: "none" }
  | { kind: "ok"; request: CommitRequest }
  | { kind: "invalid"; detail: string };

/** cwd 直下の依頼ファイルを読む。 */
export async function readCommitRequest(cwd: string): Promise<CommitRequestRead> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, COMMIT_REQUEST_FILENAME), "utf8");
  } catch {
    return { kind: "none" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: "invalid", detail: `${COMMIT_REQUEST_FILENAME} is not valid JSON: ${(error as Error).message}` };
  }
  const request = parseCommitRequest(parsed);
  if (!request) {
    return {
      kind: "invalid",
      detail: `${COMMIT_REQUEST_FILENAME} must be ${COMMIT_REQUEST_SHAPE_HINT}`,
    };
  }
  return { kind: "ok", request };
}

/** 依頼ファイルを消す。 コミット済みの依頼が残ると次の sweep で二重コミットになる。 */
export async function removeCommitRequest(cwd: string): Promise<void> {
  try {
    await unlink(join(cwd, COMMIT_REQUEST_FILENAME));
  } catch {
    // 既に無い / 権限が無いだけなら処理を止めない。 残っても guard の
    // nothing_to_commit で二重コミットは防がれる。
  }
}
