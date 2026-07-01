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
  /** 末尾の説明 ("— " 以降)。 1 行 1 リンクのときのみ。 grouped 行では ""。 */
  hook: string;
  /** 元の行 (verbatim、 退避時に MEMORY.md から該当行/リンクを特定するキー)。 */
  raw: string;
  /** このリンクの正確な markdown 文字列 (例 "[title](feedback_foo.md)")。 grouped 行で 1 リンクだけ除去する際に使う。 */
  linkText: string;
  /** この行にリンクが 1 つだけか。 true=行ごと除去可 / false=grouped (linkText だけ除去)。 */
  sole: boolean;
}

/** frontmatter から取れる最小メタ。 */
export interface Frontmatter {
  name?: string;
  description?: string;
  /** metadata.type (user / feedback / project / reference)。 */
  type?: string;
}

/** 箇条書き行か (index 行は全て `- ` で始まる)。 */
const BULLET_RE = /^\s*-\s/;
/** 行内の全 markdown リンク `[label](target)`。 */
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
/** 1 行 1 リンク行の末尾 "— hook" (リンクの後ろにある説明のみ採用)。 */
const HOOK_TAIL_RE = /\)\s*[—–-]\s+(.*)$/;

/**
 * MEMORY.md 全文を index エントリ配列に分解する。
 *
 * index は箇条書き行で、 **1 行に複数リンクを束ねた grouped 形式** ("圧縮" 索引) を取る:
 *   `- 大原則: [A](a.md) / [B](b.md) / ...`
 * そのため行頭 1 リンク前提ではなく、 各箇条書き行から全リンクを抽出する。
 * 旧来の「1 行 1 リンク + 末尾 hook」 形式も sole=true として包含する。
 */
export function parseMemoryIndex(content: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    if (!BULLET_RE.test(rawLine)) continue;
    const links = [...rawLine.matchAll(LINK_RE)];
    if (links.length === 0) continue;
    const sole = links.length === 1;
    // hook は grouped 行では各リンクへの帰属が曖昧なので 1 リンク行のときだけ採用。
    let hook = "";
    if (sole) {
      const hm = HOOK_TAIL_RE.exec(rawLine);
      if (hm) hook = hm[1].trim();
    }
    for (const m of links) {
      const link = m[2].trim();
      out.push({
        title: m[1].trim(),
        link,
        fileName: basename(link),
        hook,
        raw: rawLine,
        linkText: m[0],
        sole,
      });
    }
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
