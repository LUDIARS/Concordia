/**
 * session-log (`<workspaceRoot>/session-logs/<YYYY-MM-DD>[-N].md`) を読み、
 * Web / API / MCP から「過去の作業」を一覧・per-project 閲覧できるようにする reader。
 *
 * session-log は `/session-end` (skill save-session-log) と handoff-document
 * ワークフローが書き出す、 1 ファイル = 1 セッションの作業記録。 ファイル内の節構造は
 * 時期によって揺れる (`## スコープ` 形式 / `## — <題> / persona:` 形式) ため、
 * ここでは「1 ファイル = 1 エントリ」として頑健に扱い、 プロジェクト分類は本文全体から
 * 行う。
 */
import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { extractProjects } from "./project-dictionary.js";

/** path が存在するか (async existsSync 代替)。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 一覧用のメタ情報 (本文は含まない)。 */
export interface SessionLogMeta {
  /** ファイル名 (拡張子なし)。 例 "2026-06-22" / "2026-06-26-2"。 GET/:id のキー。 */
  id: string;
  /** YYYY-MM-DD (ファイル名から)。 解析不能なら ""。 */
  date: string;
  /** 同日連番 (無印 = 1、 `-2` = 2 ...)。 並び順に使う。 */
  seq: number;
  /** 表示用タイトル (先頭 `#` 見出し、 無ければ id)。 */
  title: string;
  /** 対象プロジェクト正式名の配列 (本文から抽出)。 */
  projects: string[];
  /** `##` 見出し一覧 (アウトライン、 最大 40)。 */
  sections: string[];
  /** バイト数。 */
  size_bytes: number;
  /** ファイル mtime (epoch 秒)。 */
  mtime: number;
  /** 本文先頭の抜粋 (見出し除く、 ~280 字)。 */
  excerpt: string;
}

/** 詳細 (本文込み)。 */
export interface SessionLogFull extends SessionLogMeta {
  content_md: string;
}

const ID_RE = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/;
const MAX_SECTIONS = 40;

/** ファイル名 (拡張子なし) + 本文から meta を組み立てる (純粋、 テスト可能)。 */
export function parseSessionLog(
  id: string,
  content: string,
  mtime: number,
  sizeBytes: number,
  projectNames: readonly string[] = [],
): SessionLogMeta {
  const m = ID_RE.exec(id);
  const date = m ? m[1] : "";
  const seq = m && m[2] ? Number(m[2]) : 1;

  const lines = content.split(/\r?\n/);
  let title = id;
  const sections: string[] = [];
  const bodyParts: string[] = [];
  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1 && title === id) {
      title = h1[1].trim();
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      if (sections.length < MAX_SECTIONS) sections.push(h2[1].trim());
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue; // その他の見出しは抜粋から除外
    const t = line.trim();
    if (t) bodyParts.push(t);
  }

  const excerptRaw = bodyParts.join(" ");
  const excerpt = excerptRaw.length > 280 ? excerptRaw.slice(0, 280) + "…" : excerptRaw;

  return {
    id,
    date,
    seq,
    title,
    projects: extractProjects(content, projectNames),
    sections,
    size_bytes: sizeBytes,
    mtime,
    excerpt,
  };
}

/**
 * workspace ルート群から session-logs ディレクトリを解決する。
 * 解決順: env `CONCORDIA_SESSION_LOGS_DIR` → `<root>/session-logs` (先頭の実在するもの)。
 * いずれも無ければ null (= ログ無し、 設定不備ではないので空一覧で扱う)。
 */
export async function resolveSessionLogsDir(roots: string[]): Promise<string | null> {
  const override = (process.env.CONCORDIA_SESSION_LOGS_DIR ?? "").trim();
  if (override) return (await pathExists(override)) ? override : null;
  for (const root of roots) {
    if (!root) continue;
    const dir = join(root, "session-logs");
    if (await pathExists(dir)) return dir;
  }
  return null;
}

/** ディレクトリ内の全 session-log を新しい順 (date desc, seq desc, mtime desc) で読む。 */
export async function readSessionLogs(dir: string, projectNames: readonly string[] = []): Promise<SessionLogMeta[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SessionLogMeta[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const id = name.slice(0, -3);
    const full = join(dir, name);
    let st: Stats;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let content = "";
    try {
      content = await readFile(full, "utf-8");
    } catch {
      continue;
    }
    out.push(parseSessionLog(id, content, Math.floor(st.mtimeMs / 1000), st.size, projectNames));
  }
  out.sort(
    (a, b) =>
      b.date.localeCompare(a.date) || b.seq - a.seq || b.mtime - a.mtime,
  );
  return out;
}

/** 1 件の本文込み詳細を読む。 path traversal を弾く。 見つからなければ null。 */
export async function readSessionLogFull(
  dir: string,
  id: string,
  projectNames: readonly string[] = [],
): Promise<SessionLogFull | null> {
  // id はファイル名のみ (スラッシュ・`..` 不可)。 念のため解決後の包含も検証する。
  if (!/^[\w.-]+$/.test(id) || id.includes("..")) return null;
  const full = resolve(dir, `${id}.md`);
  const base = resolve(dir);
  if (full !== join(base, `${id}.md`) && !full.startsWith(base + sep)) return null;
  let st: Stats;
  try {
    st = await stat(full);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let content: string;
  try {
    content = await readFile(full, "utf-8");
  } catch {
    return null;
  }
  const meta = parseSessionLog(id, content, Math.floor(st.mtimeMs / 1000), st.size, projectNames);
  return { ...meta, content_md: content };
}
