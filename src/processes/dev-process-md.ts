/**
 * dev-process.md パーサ.
 *
 * cwd に存在する `dev-process.md` を読み、 ` ```concordia.processes ` フェンス
 * (中身は JSON) からプロセス定義を抽出する.
 *
 * フェンスが無い場合は「マーカーのみ」 (= file 存在チェック用) として
 * `processes: []` を返す. これにより既存の人間向け自由記述 dev-process.md は
 * そのまま壊さず温存できる.
 *
 * 構造化フェンスの最小例:
 * ```markdown
 *     ```concordia.processes
 *     {
 *       "processes": [
 *         { "name": "backend", "command": "npm run dev:backend" },
 *         { "name": "web", "command": "npm run dev", "cwd": "web" }
 *       ]
 *     }
 *     ```
 * ```
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProcessDef {
  /** 識別名 (Concordia 内 UNIQUE). 1 .. 64 文字, [a-zA-Z0-9_.-]. */
  name: string;
  /** spawn 用 shell 行 (shell: true で実行). */
  command: string;
  /** dev-process.md ファイル位置からの相対 cwd. 省略時 "." */
  cwd?: string;
  /** 追加 env. PATH 等の継承は spawn 既定通り. */
  env?: Record<string, string>;
  /** SessionStart auto-start 対象か. 既定 true. */
  auto_start?: boolean;
  /**
   * error 行とみなす regex 配列 (case-insensitive).
   * 省略時は ["error", "panic", "fatal", "exception", "uncaught"].
   */
  error_patterns?: string[];
}

export interface DevProcessFile {
  /** dev-process.md が存在したか (= dev marker としての役割). */
  exists: boolean;
  /** 構造化フェンスから抽出された定義. フェンス無し or parse 失敗時は []. */
  processes: ProcessDef[];
  /** parse 警告 (UI 表示用). 失敗しても throw しない. */
  warnings: string[];
  /** dev-process.md 自体の絶対パス (存在しなければ null). */
  path: string | null;
}

const FENCE_RE = /```concordia\.processes\s*\n([\s\S]*?)\n```/g;
const NAME_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

export function parseDevProcessMd(content: string): { processes: ProcessDef[]; warnings: string[] } {
  const out: ProcessDef[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(content)) !== null) {
    const body = m[1].trim();
    if (!body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      warnings.push(`concordia.processes フェンスの JSON parse に失敗: ${(err as Error).message}`);
      continue;
    }
    const procs = (parsed as { processes?: unknown })?.processes;
    if (!Array.isArray(procs)) {
      warnings.push("concordia.processes フェンスに `processes` 配列がありません.");
      continue;
    }
    for (const raw of procs) {
      const def = normalizeProcessDef(raw, warnings);
      if (!def) continue;
      if (seen.has(def.name)) {
        warnings.push(`プロセス名 "${def.name}" が重複しています. 後段の定義を無視します.`);
        continue;
      }
      seen.add(def.name);
      out.push(def);
    }
  }
  return { processes: out, warnings };
}

function normalizeProcessDef(raw: unknown, warnings: string[]): ProcessDef | null {
  if (!raw || typeof raw !== "object") {
    warnings.push("プロセス定義は object である必要があります.");
    return null;
  }
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const command = typeof r.command === "string" ? r.command.trim() : "";
  if (!name || !NAME_RE.test(name)) {
    warnings.push(`プロセス name "${String(r.name)}" は不正です. ([a-zA-Z0-9_.-]{1,64})`);
    return null;
  }
  if (!command) {
    warnings.push(`プロセス "${name}" の command が空です.`);
    return null;
  }
  const def: ProcessDef = { name, command };
  if (typeof r.cwd === "string" && r.cwd.trim()) def.cwd = r.cwd.trim();
  if (r.env && typeof r.env === "object" && !Array.isArray(r.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v;
    }
    if (Object.keys(env).length) def.env = env;
  }
  if (typeof r.auto_start === "boolean") def.auto_start = r.auto_start;
  if (Array.isArray(r.error_patterns)) {
    const pats = r.error_patterns.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (pats.length) def.error_patterns = pats;
  }
  return def;
}

/**
 * `<repoPath>/dev-process.md` を読んでパース. 存在しなければ exists=false.
 */
export async function readDevProcessMd(repoPath: string): Promise<DevProcessFile> {
  const path = join(repoPath, "dev-process.md");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, processes: [], warnings: [], path: null };
    }
    return {
      exists: true,
      processes: [],
      warnings: [`dev-process.md 読み込み失敗: ${(err as Error).message}`],
      path,
    };
  }
  const { processes, warnings } = parseDevProcessMd(content);
  return { exists: true, processes, warnings, path };
}

/** error_patterns の既定値. */
export const DEFAULT_ERROR_PATTERNS = [
  "error",
  "panic",
  "fatal",
  "exception",
  "uncaught",
];
