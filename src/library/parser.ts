/**
 * メモリ/スキルの解析 (純粋関数のみ、 fs 非依存・テスト容易)。
 *
 * - MEMORY.md の index 行 (`- [Title](file.md) — hook`) → 構造化
 * - メモリ/スキルファイルの frontmatter (`name` / `description` / `metadata.type`)
 */

/** MEMORY.md の 1 index エントリ。 */
export interface IndexEntry {
  /** 見出しテキスト。 */
  title: string;
  /** リンク先 (例 "feedback_foo.md" / "../../SKILL.md")。 */
  link: string;
  /** リンク先の basename (例 "feedback_foo.md")。 メモリファイルとの突合キー。 */
  fileName: string;
  /** 末尾の説明 ("— " 以降)。 無ければ ""。 */
  hook: string;
  /** 元の行 (verbatim、 退避時に MEMORY.md から除去する対象)。 */
  raw: string;
}

/** frontmatter から取れる最小メタ。 */
export interface Frontmatter {
  name?: string;
  description?: string;
  /** metadata.type (user / feedback / project / reference)。 */
  type?: string;
}

const INDEX_RE = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]\s+(.*))?$/;

/** MEMORY.md 全文を index エントリ配列に分解する (見出し行のみ拾う)。 */
export function parseMemoryIndex(content: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const m = INDEX_RE.exec(rawLine);
    if (!m) continue;
    const title = m[1].trim();
    const link = m[2].trim();
    const hook = (m[3] ?? "").trim();
    out.push({ title, link, fileName: basename(link), hook, raw: rawLine });
  }
  return out;
}

/** frontmatter (先頭の `---` ブロック) を最小パースする。 無ければ空オブジェクト。 */
export function parseFrontmatter(content: string): Frontmatter {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return {};
  const fm: Frontmatter = {};
  const lines = m[1].split(/\r?\n/);
  let inMetadata = false;
  for (const line of lines) {
    // metadata: ブロックの入れ子 (2 スペース字下げ) を 1 段だけ見る。
    if (/^metadata\s*:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    if (inMetadata) {
      const kv = /^\s+([\w.-]+)\s*:\s*(.*)$/.exec(line);
      if (kv && kv[1] === "type") {
        fm.type = stripQuotes(kv[2].trim());
        continue;
      }
      // 字下げが切れたら metadata ブロック終了。
      if (!/^\s/.test(line) && line.trim() !== "") inMetadata = false;
    }
    const top = /^([\w.-]+)\s*:\s*(.*)$/.exec(line);
    if (top) {
      const key = top[1];
      const val = stripQuotes(top[2].trim());
      if (key === "name") fm.name = val;
      else if (key === "description") fm.description = val;
    }
  }
  return fm;
}

/** 1 行目が `# 見出し` ならその文字列を返す (frontmatter の後の最初の見出し)。 */
export function firstHeading(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h) return h[1].trim();
  }
  return null;
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
