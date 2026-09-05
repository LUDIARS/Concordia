/**
 * スキルカタログ — Castra (`<workspaceRoot>/.claude/`) と user 領域に置かれた
 * 「スキル」の一覧を作る (設計 §10.2 C-8)。
 *
 * 置き場は 3 箇所ある:
 *  - `<root>/.claude/skills/<name>/SKILL.md` … スキル本体 (source: "skills")
 *  - `<root>/.claude/commands/<name>.md`     … スラッシュコマンド (source: "commands")
 *  - `~/.claude/skills/<name>/SKILL.md`      … user 個人のスキル (source: "user")
 *
 * どちらも YAML frontmatter (`name` / `description` / `metadata.rwf`) を持つので
 * 同じパーサで扱う。 frontmatter が無いファイルは先頭の見出し行を description の
 * 代わりに使う。
 *
 * **安全上の約束**: SKILL.md の本文は「他人が書いたテキスト」として扱う。 ここは
 * 列挙するだけで、 本文に書かれた指示を Concordia が実行することはない
 * (RWF が headless で本文を渡すときも `<skill-instructions>` で囲んだ資料として渡す)。
 * 走査対象は指定ルート配下に限定し、 `..` やパス区切りを含む名前は弾く。
 *
 * SRP: 走査と frontmatter 解析のみ。 キャッシュは catalog-store.ts、
 * RWF への写像は platform/reaction-workflow-skill.ts が持つ。
 *
 * @implements SPEC-RWF-SKILL-CATALOG
 */

import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { load as loadYaml } from "js-yaml";

/** スキルの置き場。 表示と RWF 設定画面のグループ分けに使う。 */
export type SkillSource = "skills" | "commands" | "user";

/** 同名スキルの解決順。 workspace の正規 skill を command / user より優先する。 */
const SKILL_SOURCE_PRIORITY: Readonly<Record<SkillSource, number>> = {
  skills: 0,
  commands: 1,
  user: 2,
};

/** frontmatter `metadata.rwf` の 1 割り当て (絵文字 → このスキル)。 */
export interface SkillRwfBinding {
  /** 割り当てる絵文字 (異体字セレクタ付き/無しの両方が並ぶことがある)。 */
  emoji: string[];
  /** 移行の突き合わせ用の WorkflowAction 名。 宣言が無ければ null。 */
  action: string | null;
  /** スキルへ渡す引数文字列 (例 `--report-only`)。 */
  args: string | null;
  /** 主たる実行手段。 */
  mode: "inject" | "headless";
  /** headless 時のモデル別名 (opus / sonnet / haiku)。 */
  model: string | null;
  /** cwd トークン (repo / memoria / castra) または絶対パス。 */
  cwd: string | null;
}

/** 一覧 1 件。 API が返すのはこの形。 */
export interface SkillCatalogEntry {
  name: string;
  /** frontmatter description の先頭 1 文 (無ければ先頭見出し)。 */
  description: string;
  /** SKILL.md / コマンド md の絶対パス。 */
  path: string;
  source: SkillSource;
  /** frontmatter `metadata.rwf` から読んだ割り当て (0 件なら RWF 対象外)。 */
  rwf: SkillRwfBinding[];
}

/** 走査結果。 弾いた入力は notes に理由を残す (無言スキップにしない)。 */
export interface SkillCatalog {
  entries: SkillCatalogEntry[];
  notes: string[];
  scannedAt: number;
}

/** description / name の暴走を防ぐ上限 (一覧 API と GUI の表示に載るため)。 */
const MAX_DESCRIPTION = 400;
const MAX_NAME = 64;
/** headless へ渡す SKILL.md 本文の上限。 */
export const MAX_SKILL_BODY = 24_000;

/**
 * 走査ルートを決める。 workspaceRoot は Castra (`E:/Document/Ars` 等)。
 * user 領域は `~/.claude/skills`。
 */
export function skillCatalogRoots(workspaceRoot: string): Array<{ dir: string; source: SkillSource }> {
  const roots: Array<{ dir: string; source: SkillSource }> = [];
  const root = workspaceRoot.trim();
  if (root) {
    roots.push({ dir: join(root, ".claude", "skills"), source: "skills" });
    roots.push({ dir: join(root, ".claude", "commands"), source: "commands" });
  }
  const home = homedir();
  if (home) roots.push({ dir: join(home, ".claude", "skills"), source: "user" });
  return roots;
}

/** ディレクトリ名 / ファイル名として安全か (パス traversal を許さない)。 */
export function isSafeSkillName(name: string): boolean {
  if (!name || name.length > MAX_NAME) return false;
  if (name.includes("..")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.startsWith(".")) return false;
  return true;
}

/** resolved が base 配下に収まっているか (symlink 経由の脱出も弾く最後の砦)。 */
function isInside(base: string, target: string): boolean {
  const b = resolve(base);
  const t = resolve(target);
  return t === b || t.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * 1 ドキュメント (SKILL.md / コマンド md) を解析する。 純粋関数。
 * `fallbackName` はファイル名由来の名前 (frontmatter に name が無いとき使う)。
 */
export function parseSkillDocument(
  raw: string,
  fallbackName: string,
): { name: string; description: string; rwf: SkillRwfBinding[] } {
  const { frontmatter, body } = splitFrontmatter(raw);
  let name = fallbackName;
  let description = "";
  let rwf: SkillRwfBinding[] = [];
  if (frontmatter) {
    const fm = parseYamlObject(frontmatter);
    if (fm) {
      if (typeof fm.name === "string" && fm.name.trim()) name = fm.name.trim();
      if (typeof fm.description === "string") description = firstSentence(fm.description);
      const metadata = fm.metadata;
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        rwf = parseRwfBindings((metadata as Record<string, unknown>).rwf);
      }
    }
  }
  if (!description) description = firstHeading(body);
  return {
    name: clip(name, MAX_NAME),
    description: clip(description, MAX_DESCRIPTION),
    rwf,
  };
}

/** frontmatter を落とした本文 (headless に渡す資料)。 */
export function skillDocumentBody(raw: string): string {
  return splitFrontmatter(raw).body.trim();
}

/** 1 ルートを走査する。 読めないファイルは飛ばす。 */
async function scanRoot(
  dir: string,
  source: SkillSource,
  notes: string[],
): Promise<SkillCatalogEntry[]> {
  let dirents;
  let realRoot: string;
  try {
    realRoot = await realpath(dir);
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    // 不在は正常 (commands を置いていない環境がある)。 notes には残さない。
    return [];
  }
  const out: SkillCatalogEntry[] = [];
  const isCommandDir = source === "commands";
  for (const dirent of dirents) {
    const rawName = dirent.name;
    if (isCommandDir) {
      if (!dirent.isFile() || !/\.md$/i.test(rawName)) continue;
    } else if (!dirent.isDirectory()) {
      continue;
    }
    const baseName = isCommandDir ? rawName.replace(/\.md$/i, "") : rawName;
    if (!isSafeSkillName(baseName)) {
      notes.push(`unsafe skill name skipped: ${source}/${rawName}`);
      continue;
    }
    const candidatePath = isCommandDir ? join(dir, rawName) : join(dir, rawName, "SKILL.md");
    if (!isInside(dir, candidatePath)) {
      notes.push(`skill path escaped its root: ${source}/${rawName}`);
      continue;
    }
    let raw: string;
    let path: string;
    try {
      path = await realpath(candidatePath);
      if (!isInside(realRoot, path)) {
        notes.push(`skill symlink escaped its root: ${source}/${rawName}`);
        continue;
      }
      raw = await readFile(path, "utf-8");
    } catch {
      // skills/<name>/ に SKILL.md が無いディレクトリは対象外 (README 置き場等)。
      continue;
    }
    const parsed = parseSkillDocument(raw, baseName);
    out.push({ name: parsed.name, description: parsed.description, path, source, rwf: parsed.rwf });
  }
  return out;
}

/**
 * 全ルートを走査して一覧を作る。 同じ (name, source) の重複は先勝ち。
 */
export async function scanSkillCatalog(
  workspaceRoot: string,
  opts: { now?: () => number } = {},
): Promise<SkillCatalog> {
  const notes: string[] = [];
  const entries: SkillCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const root of skillCatalogRoots(workspaceRoot)) {
    for (const entry of await scanRoot(root.dir, root.source, notes)) {
      const key = `${entry.name}|${entry.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  entries.sort(
    (a, b) => a.name.localeCompare(b.name)
      || SKILL_SOURCE_PRIORITY[a.source] - SKILL_SOURCE_PRIORITY[b.source],
  );
  return { entries, notes, scannedAt: (opts.now ?? Date.now)() };
}

/**
 * 1 スキルの本文を読む (headless 実行でシステム文脈として渡す用)。
 * カタログに載っているエントリだけを受ける — 呼び出し側が任意のパスを渡せると、
 * 一覧 API がファイル読み出しの穴になる。
 */
export async function readSkillBody(entry: SkillCatalogEntry): Promise<string | null> {
  try {
    // 走査後にファイルが外向き symlink へ差し替えられても、任意ファイルを本文として
    // 読み込まない。entry.path は scanRoot が保存した real path。
    const currentPath = await realpath(entry.path);
    if (resolve(currentPath) !== resolve(entry.path)) return null;
    const raw = await readFile(currentPath, "utf-8");
    return clip(skillDocumentBody(raw), MAX_SKILL_BODY);
  } catch {
    return null;
  }
}

// ─── 解析ヘルパ ────────────────────────────────────────────────────────────

function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(text)) return { frontmatter: null, body: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: null, body: text };
  const afterMarker = text.indexOf("\n", end + 1);
  return {
    frontmatter: text.slice(4, end),
    body: afterMarker < 0 ? "" : text.slice(afterMarker + 1),
  };
}

function parseYamlObject(source: string): Record<string, unknown> | null {
  try {
    const parsed = loadYaml(source) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // frontmatter が壊れていても一覧は出す (name/description はファイル名と見出しへ落ちる)。
  }
  return null;
}

/**
 * `metadata.rwf` を正規化する。 オブジェクト 1 個も配列も同じ形で受ける
 * (`.claude/skills/README-rwf-skills.md` の約束「1 個は 1 要素の配列として読む」)。
 */
export function parseRwfBindings(value: unknown): SkillRwfBinding[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const out: SkillRwfBinding[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const emoji = toEmojiList(item.emoji);
    if (emoji.length === 0) continue;
    out.push({
      emoji,
      action: str(item.action),
      args: str(item.args),
      mode: item.mode === "headless" ? "headless" : "inject",
      model: str(item.model),
      cwd: str(item.cwd),
    });
  }
  return out;
}

function toEmojiList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * description の先頭 1 文。
 * 全角終止符 (。．！？) はその場で切る — 日本語は句点の後ろに空白を置かない。
 * 半角の `.` / `!` / `?` は空白か行末が続くときだけ切る (`e.g.` で切らないため)。
 */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const jp = /^[\s\S]*?[。．！？]/u.exec(flat);
  if (jp) return jp[0];
  const ascii = /^([\s\S]*?[.!?])(\s|$)/u.exec(flat);
  return ascii ? ascii[1] : flat;
}

/** frontmatter を持たないファイルの代替 description = 先頭の見出し行。 */
function firstHeading(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) return heading[1].trim();
  }
  const firstText = body.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstText ? firstText.trim() : "";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
