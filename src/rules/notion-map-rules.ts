/**
 * Notion 記事マップの規則 (純関数、 spec/feature/patrol-chat.md「知識」の「Notion 記事マップ」)。
 *
 * - 起点の設定 (1 行 1 件) から 32 桁のページ ID と公開 URL (*.notion.site、 あれば) を読む
 * - 除外: 題名やパスに除外語 (個人ページ・チーム・タスクリスト等) を含むページとその配下は読まない
 */

import { NOTION_MAP_DEFAULT_EXCLUDES, NOTION_MAP_DEFAULT_ROOTS } from "./notion-map-types.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:c9547c33 */
import augurContract_3898cca7 from './notion-map-exclude.contract.js'; /* augur-inject:contract-predicate:b106a8a2 */

/** ページ ID を 32 桁の小文字 16 進 (区切りなし) にする。 読めなければ null。 */
export function normalizeNotionId(raw: string): string | null {
  const m = raw.toLowerCase().match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/);
  return m ? m[0].replace(/-/g, "") : null;
}

const PUBLIC_URL_HEAD = /^https:\/\/[^/]+\.notion\.site\//i;

/**
 * 起点の設定を読む。 各行の先頭はページ ID か公開ページの URL (*.notion.site、 末尾が ID)。 後ろの名前は注記として捨てる。
 * 重複は先勝ち。 未設定は既定値。
 */
export function parseRoots(lines: readonly string[] | null): Array<{ id: string; url: string | null }> {
  const source = lines && lines.length > 0 ? lines : NOTION_MAP_DEFAULT_ROOTS;
  const out: Array<{ id: string; url: string | null }> = [];
  for (const line of source) {
    const head = line.trim().split(/\s+/)[0] ?? "";
    const id = normalizeNotionId(head);
    if (!id || out.some((r) => r.id === id)) continue;
    out.push({ id, url: PUBLIC_URL_HEAD.test(head) ? head : null });
  }
  return out;
}

/** 起点のページ ID だけ。 */
export function parseRootIds(lines: readonly string[] | null): string[] {
  return parseRoots(lines).map((r) => r.id);
}

/** 除外語。 既定の 4 語に設定の語を足す (空・重複は捨てる)。 */
export function excludeWords(extra: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of [...NOTION_MAP_DEFAULT_EXCLUDES, ...extra]) {
    const t = w.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

const fold = (s: string) => s.normalize("NFKC").toLowerCase();

/** 題名かパスに除外語を含むか。 パスは起点からの題の並びなので、 祖先が除外なら配下も除外になる。 */
export function isExcludedPage(title: string, path: string, words: readonly string[]): boolean {
  const hay = fold(`${path}\n${title}`);
  return words.some((w) => w.trim() !== "" && hay.includes(fold(w.trim())));
}
// @ts-expect-error augur-inject
isExcludedPage = contract(isExcludedPage, { ...augurContract_3898cca7, contractId: 'chat-knowledge-C-7', mode: 'observe', sample: 1, where: 'src/rules/notion-map-rules.ts:42', rule: 'contract-wrap', id: '3898cca7' }); /* augur-inject:contract-wrap:3898cca7 */

/** 起点からの題の並び。 */
export function joinPath(parentPath: string | null, title: string): string {
  return parentPath ? `${parentPath} > ${title}` : title;
}
