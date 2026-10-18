/**
 * Notion 記事マップの型と既定値 (spec/feature/patrol-chat.md「知識」の「Notion 記事マップ」)。
 *
 * 決まった起点ページ (設定) から子ページ (子データベースの行を含む) を下ってクロールし、 ページごとに
 * 題・パス・要約・キーワード・ページ間の参照 (辺) を持つ。 本文の断片は知識テーブル (doc_type `notion-page`) に置く。
 * 取得は公開ページのクロールと MCP (claude.ai の Notion コネクタ) の 2 経路 (notion-source-*.ts)。 公式 API とトークンは使わない。
 */

/**
 * 起点の既定値 (neco 確認済み 2026-10-18)。 設定 `services.notion_map_roots` が未設定ならこれを使う。
 * 1 行 1 件。 先頭は 32 桁の ID か公開ページの URL (*.notion.site)。 後ろの名前は人が見るための注記。
 * 25 生は「授業内容」ページの ID が分からないため 25 生を起点にし、 除外規則で生徒・チームのページを外す。
 */
export const NOTION_MAP_DEFAULT_ROOTS: readonly string[] = Object.freeze([
  "37ee328c2b5b4a488bbb35f02f34f2ca ゲーム開発攻略ページ",
  "bb17fed985ee4be19e3625cc1114f251 21生用授業資料",
  "e11059a2b8fb479ebf233e4aa3f1cd2c 22生用授業資料 - Aクラス",
  "3e9b26127f224484bf4d67cb7e15eaa2 22生向け共通資料",
  "198b1fb8a3b9434d8aa9b538a63b85c0 23生向け 2年次授業資料",
  "1b439cbfbab980e18dc2f3e12b44d1d1 24生向け 2年次授業資料",
  "1f739cbfbab980c3a6d1f4afa84f372a 過去の授業資料一覧",
  "30339cbfbab980628cffeb15969a1b19 25生",
]);

/** 除外の既定語 (個人情報)。 題名かパスに含むページとその配下は読まない。 設定 `services.notion_map_exclude` で足せる。 */
export const NOTION_MAP_DEFAULT_EXCLUDES: readonly string[] = Object.freeze([
  "個人ページ", "チーム", "タスクリスト", "チームテンプレート",
]);

export interface NotionMapLimits {
  /** 起点からの深さ (起点 = 0)。 */
  maxDepth: number;
  /** 起点 1 つあたりのページ数。 */
  maxPages: number;
  /** ページ 1 件の本文バイト。 */
  pageTextBytes: number;
}

export const NOTION_MAP_DEFAULT_LIMITS: NotionMapLimits = Object.freeze({ maxDepth: 6, maxPages: 400, pageTextBytes: 6000 });

/** 1 ページから下る子ページ (子データベースの行を含む) の数の上限。 */
export const NOTION_MAP_CHILDREN_PER_PAGE = 100;

/** ページ間の参照の種類。 `child` は親 → 子 (子データベースの行を含む)、 `link` は本文中の他ページへの参照。 */
export type NotionEdgeKind = "child" | "link";

export interface NotionEdge {
  from: string;
  to: string;
  kind: NotionEdgeKind;
}

/** 記事マップに置くページ 1 件 (除外したページは作らない)。 */
export interface NotionMapPage {
  page_id: string;
  root_id: string;
  title: string;
  url: string | null;
  /** 起点からの題の並び (`起点 > 章 > 回`)。 */
  path: string;
  depth: number;
  /** Notion の last_edited_time (ms)。 */
  last_edited_ms: number | null;
  /** 要約 (haiku)。 未解析・解析失敗は null。 */
  summary: string | null;
  keywords: string[];
  /** 解析が要る (本文が変わった、 または前回の解析が失敗した)。 */
  analysis_pending: boolean;
}

/** 起点 1 つの状態とまとめ。 */
export interface NotionMapRootState {
  root_id: string;
  title: string | null;
  pages: number;
  excluded: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  /** 起点配下で扱っている内容の概要・主な章 / 回・主要キーワード (haiku)。 */
  summary: string | null;
  /** まとめを作ったときの配下の指紋。 変わったときだけ作り直す。 */
  summary_basis: string | null;
}

/** マップ全体の概観 (決定的に作る)。 */
export interface NotionMapOverview {
  generated_at: number;
  total_pages: number;
  roots: Array<{ root_id: string; title: string; pages: number; topics: string[] }>;
  topics: string[];
}
