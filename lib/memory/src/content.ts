/**
 * block / 退避ファイルの中身読み出し (path-traversal 安全)。
 *
 * - live: source rootDir 配下の relPath
 * - archived: source rootDir/_archive 配下の relPath (台帳の archivedAs)
 * dir-skill は中の SKILL.md を読む。 `src/session-logs/reader.ts` の包含チェックに倣う。
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";

const MAX_BYTES = 200_000;
const ARCHIVE_DIRNAME = "_archive";

export interface BlockContent {
  path: string;
  content: string;
  truncated: boolean;
  size_bytes: number;
}

export function readBlockContent(
  rootDir: string,
  relPath: string,
  archived: boolean,
): BlockContent | null {
  const base = resolve(archived ? join(rootDir, ARCHIVE_DIRNAME) : rootDir);
  const target = resolve(base, relPath);
  // 包含チェック (base 自身 or base/ 配下のみ許可)。
  if (target !== base && !target.startsWith(base + sep)) return null;
  if (!existsSync(target)) return null;

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(target);
  } catch {
    return null;
  }

  let filePath = target;
  if (st.isDirectory()) {
    const skillMd = join(target, "SKILL.md");
    if (!existsSync(skillMd)) return null;
    filePath = skillMd;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const truncated = raw.length > MAX_BYTES;
  return {
    path: relPath,
    content: truncated ? raw.slice(0, MAX_BYTES) : raw,
    truncated,
    size_bytes: Buffer.byteLength(raw, "utf8"),
  };
}
