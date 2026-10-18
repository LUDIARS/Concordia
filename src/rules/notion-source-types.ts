/**
 * Notion のページの取得経路 (port) の型 (spec/feature/patrol-chat.md「知識」の「Notion 記事マップ」)。
 *
 * neco 指示 (2026-10-18)「Notion はトークンを使わず MCP とクロールで対応」。 公式 API と連携トークンは使わない。
 * - `public`: 公開ページ (*.notion.site) の HTML をクロールする (notion-source-public.ts)
 * - `mcp`: claude -p の one-shot runner で、 利用者の claude.ai Notion コネクタの読み取りツールだけを許して呼ぶ (notion-source-mcp.ts)
 * 公開 URL が分かるページは public を優先し、 取れなければ mcp (notion-source-route.ts)。
 */

/** 取得するページ。 url は分かっていれば (公開 URL なら public 経路を使う)。 */
export interface NotionPageRef {
  id: string;
  url: string | null;
  /** 親のページ一覧で分かった題 (除外の判定を取得前にするため)。 */
  title?: string | null;
}

/** 取得した 1 ページ。 */
export interface FetchedNotionPage {
  id: string;
  title: string;
  url: string | null;
  /** 最終更新 (ms)。 経路が教えてくれなければ null (本文の指紋で差分を見る)。 */
  lastEditedMs: number | null;
  /** 本文 (テキスト、 上限バイト以下)。 */
  text: string;
  /** 子ページ (子データベースの行を含む)。 */
  children: NotionPageRef[];
  /** 本文中の他ページへの参照 (link_to_page・mention・リンク)。 */
  links: string[];
  /** 取れた経路。 */
  via: "public" | "mcp";
}

/** 経路が使えない (MCP 未認証・Notion コネクタ無し)。 Notion の取り込みだけを「未設定」として止める。 */
export class NotionSourceUnavailable extends Error {}

/** 取得の上限。 */
export interface NotionFetchLimits {
  /** ページ 1 件の本文バイト。 */
  pageTextBytes: number;
  /** 1 ページの子ページの数。 */
  maxChildren: number;
}

export interface NotionPageSource {
  /** 1 ページを取る。 見つからない・共有されていないページは null。 経路が使えなければ NotionSourceUnavailable。 */
  fetchPage(ref: NotionPageRef, limits: NotionFetchLimits): Promise<FetchedNotionPage | null>;
}
