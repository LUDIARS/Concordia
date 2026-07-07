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
/**
 * MEMORY.md 全文を index エントリ配列に分解する。
 *
 * index は箇条書き行で、 **1 行に複数リンクを束ねた grouped 形式** ("圧縮" 索引) を取る:
 *   `- 大原則: [A](a.md) / [B](b.md) / ...`
 * そのため行頭 1 リンク前提ではなく、 各箇条書き行から全リンクを抽出する。
 * 旧来の「1 行 1 リンク + 末尾 hook」 形式も sole=true として包含する。
 */
export declare function parseMemoryIndex(content: string): IndexEntry[];
/** frontmatter (先頭の `---` ブロック) を最小パースする。 無ければ空オブジェクト。 */
export declare function parseFrontmatter(content: string): Frontmatter;
/** 1 行目が `# 見出し` ならその文字列を返す (frontmatter の後の最初の見出し)。 */
export declare function firstHeading(content: string): string | null;
