/**
 * 別リポジトリの md 正本を委託 prompt へ同梱する。
 *
 * 背景 (2026-09-05 の問題ログ): 委託文が cwd の外にある設計書を**パスで示しただけ**だった
 * ため、 子セッションはそれを読めず、 前提が欠けたまま人へ質問して止まった。 パス列挙
 * (task-workflow.md §3.2 の「参照メモリ」) は同じ repo の中でしか成立しない。
 *
 * 同梱の対象は**明示された参照だけ**に限る (`memory_links` と allowlist した file-ref
 * input)。 自由文の task / context_extra からパスらしい文字列を拾って読むことはしない —
 * 委託文に紛れ込んだ任意のパスを Concordia が読んで prompt へ写す経路になるため。
 *
 * 読む前に realpath を解決し、 登録済み repo root の中にあることを確認する。 未登録
 * ディレクトリ、 ユーザープロファイル、 symlink / `..` による repo 外への脱出は読まず、
 * 理由付きの非同梱注記だけを prompt に出す。
 *
 * @implements spec/feature/task-workflow.md §3.2 — 別リポ md は同梱する
 */

import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

/** 本文を読み込んでよい file-ref input のキー (allowlist)。 自由文キーは入れない。 */
export const FILE_REF_INPUT_KEYS = ["design_path", "spec_path", "doc_path", "plan_path"] as const;

/** 1 prompt に同梱する本文全体の上限。 UTF-8 byte と行数の両方で切る。 */
export const EXTERNAL_DOC_MAX_BYTES = 24 * 1024;
export const EXTERNAL_DOC_MAX_LINES = 600;

/** 登録済みプロジェクト (project_codes の必要分だけ)。 */
export interface RegisteredRepo {
  project: string;
  repo_path: string;
}

export interface BundledExternalDoc {
  /** `<project>:<repo-relative-path>` に正規化した同梱元。 絶対パスは残さない。 */
  label: string;
  content: string;
  truncated: boolean;
}

export interface SkippedExternalDoc {
  ref: string;
  reason: string;
}

export interface ExternalDocBundle {
  /** prompt へ足す「同梱正本」節 (同梱も非同梱注記も無ければ空文字)。 */
  section: string;
  /** run へ記録する同梱元ラベル。 */
  labels: string[];
  skipped: SkippedExternalDoc[];
}

/** fs アクセスの DI 点 (テストは実ファイルで足りるが、 異常系を作るために開けておく)。 */
export interface ExternalDocFs {
  realpath: (path: string) => string;
  isFile: (path: string) => boolean;
  /** Reads at most maxBytes + 1 so truncation never loads an unbounded file. */
  read: (path: string, maxBytes: number) => Buffer;
}

function readLimited(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const count = readSync(fd, buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

const defaultFs: ExternalDocFs = {
  realpath: (path) => realpathSync(path),
  isFile: (path) => statSync(path).isFile(),
  read: readLimited,
};

/**
 * 同梱候補の参照を集める。 `memory_links` と allowlist した input キーだけを見る。
 * 相対パス・URL・非 md はここでは落とさず、 後段の検証で理由付きに落とす。
 */
export function collectExternalDocRefs(input: {
  args?: Record<string, unknown> | null;
  memoryLinks?: readonly string[] | null;
}): string[] {
  const refs: string[] = [];
  for (const link of input.memoryLinks ?? []) {
    if (typeof link === "string" && link.trim()) refs.push(link.trim());
  }
  for (const key of FILE_REF_INPUT_KEYS) {
    const value = input.args?.[key];
    if (typeof value === "string" && value.trim()) refs.push(value.trim());
  }
  return [...new Set(refs)];
}

/**
 * 参照を検証して本文を同梱する。
 *
 * 同梱するのは「spawn cwd の外」かつ「spawn cwd が属するのとは別の登録済み repo の中」に
 * ある `.md` だけ。 cwd 内 / 同じ repo 内の文書は子が自分で読めるので展開しない
 * (prompt を無駄に膨らませない)。
 */
export function buildExternalDocBundle(input: {
  refs: readonly string[];
  /** 子の作業ディレクトリ (worktree)。 */
  spawnCwd: string | null;
  /** spawn cwd が属する登録済み repo root (無ければ null)。 */
  spawnRepoPath?: string | null;
  repos: readonly RegisteredRepo[];
  fs?: ExternalDocFs;
  maxBytes?: number;
  maxLines?: number;
}): ExternalDocBundle {
  const fs = input.fs ?? defaultFs;
  const maxBytes = input.maxBytes ?? EXTERNAL_DOC_MAX_BYTES;
  const maxLines = input.maxLines ?? EXTERNAL_DOC_MAX_LINES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > EXTERNAL_DOC_MAX_BYTES) {
    throw new RangeError(`maxBytes must be an integer between 1 and ${EXTERNAL_DOC_MAX_BYTES}`);
  }
  if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > EXTERNAL_DOC_MAX_LINES) {
    throw new RangeError(`maxLines must be an integer between 1 and ${EXTERNAL_DOC_MAX_LINES}`);
  }
  const docs: BundledExternalDoc[] = [];
  const skipped: SkippedExternalDoc[] = [];
  let remainingBytes = maxBytes;
  let remainingLines = maxLines;

  for (const ref of input.refs) {
    const outcome = resolveRef(ref, { ...input, fs });
    if ("reason" in outcome) {
      skipped.push({ ref, reason: outcome.reason });
      continue;
    }
    if (remainingBytes === 0 || remainingLines === 0) {
      skipped.push({ ref, reason: "同梱本文の上限に達した" });
      continue;
    }
    let raw: Buffer;
    try {
      raw = fs.read(outcome.realPath, remainingBytes);
    } catch {
      // Filesystem errors can contain private absolute paths. This reason is
      // rendered into a child prompt, so do not relay the original message.
      skipped.push({ ref, reason: "読み込みに失敗した" });
      continue;
    }
    const { text, truncated } = capContent(raw, remainingBytes, remainingLines);
    docs.push({ label: outcome.label, content: text, truncated });
    remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(text, "utf8"));
    remainingLines = Math.max(0, remainingLines - contentLineCount(text));
  }

  return { section: renderSection(docs, skipped), labels: docs.map((doc) => doc.label), skipped };
}

function contentLineCount(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function resolveRef(
  ref: string,
  input: {
    spawnCwd: string | null;
    spawnRepoPath?: string | null;
    repos: readonly RegisteredRepo[];
    fs: ExternalDocFs;
  },
): { label: string; realPath: string } | { reason: string } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return { reason: "URL は同梱しない (子が必要なら自分で取得する)" };
  if (!isAbsolute(ref)) return { reason: "相対パスは基準が定まらないので同梱しない" };
  if (!ref.toLowerCase().endsWith(".md")) return { reason: "md 以外は同梱しない" };

  let realPath: string;
  try {
    realPath = input.fs.realpath(ref);
    if (!input.fs.isFile(realPath)) return { reason: "ファイルではない" };
  } catch {
    return { reason: "パスを解決できない (存在しない / 権限が無い)" };
  }
  // Judge the resolved target too. A `.md` symlink must not turn an arbitrary
  // registered-repo file into an allowed document.
  if (!realPath.toLowerCase().endsWith(".md")) return { reason: "実体が md ではないので同梱しない" };

  // symlink や `..` は realpath 解決後の実体で判定する (解決前のパスで許可しない)。
  const spawnCwd = resolveKnownPath(input.spawnCwd, input.fs);
  if (spawnCwd && isInside(realPath, spawnCwd)) {
    return { reason: "作業ディレクトリの中にあるので子が直接読める" };
  }
  const repos = input.repos.flatMap((candidate): Array<RegisteredRepo & { real_path: string }> => {
    const realRoot = resolveKnownPath(candidate.repo_path, input.fs);
    return realRoot ? [{ ...candidate, real_path: realRoot }] : [];
  });
  const repo = repos.find((candidate) => isInside(realPath, candidate.real_path));
  if (!repo) return { reason: "登録済み repo の外にあるので読まない" };
  const spawnRepoPath = resolveKnownPath(input.spawnRepoPath, input.fs);
  if (spawnRepoPath && isInside(realPath, spawnRepoPath)) {
    return { reason: "作業対象と同じ repo なので子が直接読める" };
  }
  return { label: `${repo.project}:${repoRelative(repo.real_path, realPath)}`, realPath };
}

function resolveKnownPath(path: string | null | undefined, fs: ExternalDocFs): string | null {
  if (!path) return null;
  try {
    return fs.realpath(path);
  } catch {
    return null;
  }
}

function normalize(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(path: string, root: string): boolean {
  const normalizedRoot = normalize(root);
  if (!normalizedRoot) return false;
  const target = normalize(path);
  return target === normalizedRoot || target.startsWith(`${normalizedRoot}/`);
}

function repoRelative(root: string, path: string): string {
  return relative(root, path).replace(/\\/g, "/");
}

/**
 * byte 数と行数の両方で切る。 byte で切るときは**完全な文字の境界まで**戻す
 * (UTF-8 の途中で切ると壊れた文字が prompt に載る)。
 */
export function capContent(
  raw: Buffer,
  maxBytes: number,
  maxLines: number,
): { text: string; truncated: boolean } {
  let truncated = false;
  let buffer = raw;
  if (buffer.byteLength > maxBytes) {
    buffer = buffer.subarray(0, maxBytes);
    truncated = true;
  }
  // TextDecoder の fatal=false は末尾の不完全な列を U+FFFD にするので、 それを削る。
  let text = new TextDecoder("utf-8").decode(buffer);
  if (truncated) text = text.replace(/�+$/, "");
  const lines = text.split(/\r?\n/);
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  return { text, truncated };
}

function renderSection(docs: readonly BundledExternalDoc[], skipped: readonly SkippedExternalDoc[]): string {
  if (docs.length === 0 && skipped.length === 0) return "";
  const lines = [
    "## 同梱正本 (別リポの文書)",
    "",
    "この節は Concordia が別リポジトリから読み出して貼った本文です。 パスを開き直す必要はありません。",
    "",
  ];
  for (const doc of docs) {
    lines.push(`### ${doc.label}`, "");
    lines.push(doc.content.trimEnd(), "");
    if (doc.truncated) {
      lines.push(`(上限で省略。 全文は \`${doc.label}\` を参照。 必要なら親セッションへ追加同梱を依頼する)`, "");
    }
  }
  if (skipped.length > 0) {
    lines.push("### 同梱しなかった参照", "");
    // Do not relay rejected absolute paths or URLs: they can contain usernames,
    // private endpoints, or local configuration. The ordered reason is enough
    // for the caller to identify the explicit input that was rejected.
    skipped.forEach((item, index) => lines.push(`- 参照 ${index + 1}: ${item.reason}`));
    lines.push("");
  }
  return lines.join("\n");
}
