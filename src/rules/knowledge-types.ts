/**
 * 巡回チャットの知識 (spec/feature/patrol-chat.md「知識」) の型。
 *
 * 取り込み器 (LUDIARS 内部 / Revisor / Notion) が出典ごとの文書を返し、 取り込み (knowledge-ingest.ts) が
 * 秘匿語で除いてから断片に切って DB に置く。 生成のときは DB から関連の高い断片を選ぶ (knowledge-select.ts)。
 */

/** 取り込みの単位。 種類ごとに状態 (最終取得・失敗理由) を持ち、 失敗しても他の種類は止めない。 */
export type KnowledgeSourceKind = "ludiars" | "revisor" | "notion";

export const KNOWLEDGE_SOURCE_KINDS: readonly KnowledgeSourceKind[] = ["ludiars", "revisor", "notion"];

/** 断片の出典の種類。 */
export type KnowledgeDocType = "project" | "readme" | "spec" | "merged-pr" | "notion-page";

/**
 * 断片の公開範囲。 `public` の宛先 (子会社・scope_key=public・個別チャンネル) には `hq` を出さない (CC-PATROL-05)。
 */
export type KnowledgeScope = "hq" | "public";

/** 取り込み器が返す文書 1 件 (断片に切る前)。 */
export interface KnowledgeDoc {
  docType: KnowledgeDocType;
  /** 出典ごとの鍵 (例 `project:Cc`・`repo:Cc:README.md`・`notion:<page id>`)。 同じ鍵の断片は置き換える。 */
  docKey: string;
  title: string;
  url: string | null;
  repo: string | null;
  path: string | null;
  scope: KnowledgeScope;
  text: string;
  /** 出典側の更新時刻 (秒)。 不明なら null。 */
  sourceUpdatedAt: number | null;
}

/** DB に置いた断片 1 件。 */
export interface KnowledgeChunk {
  id: number;
  source_kind: KnowledgeSourceKind;
  doc_type: KnowledgeDocType;
  doc_key: string;
  seq: number;
  title: string;
  url: string | null;
  repo: string | null;
  path: string | null;
  scope: KnowledgeScope;
  body: string;
  source_updated_at: number | null;
  fetched_at: number;
}

/** 取り込み器の結果。 `full` は種類ごと置き換え、 差分 (`full=false`) は届いた文書だけを置き換える。 */
export interface KnowledgeCollection {
  docs: KnowledgeDoc[];
  full: boolean;
  /** 次回の差分取得の起点 (Notion の last_edited_time)。 */
  cursor: string | null;
}

/** 取り込み器。 未設定 (Notion のトークンなし) は `not-configured` を投げずに返す。 */
export type KnowledgeCollector = (opts: { cursor: string | null; full: boolean }) =>
  Promise<KnowledgeCollection | { notConfigured: string }>;

/** 生成に渡す知識 1 件 (出典と本文)。 */
export interface RenderKnowledge {
  title: string;
  body: string;
}

/** rule_runs.decision に残す出典 (本文は残さない)。 */
export interface KnowledgeSourceRef {
  source_kind: KnowledgeSourceKind;
  doc_type: KnowledgeDocType;
  title: string;
  url: string | null;
  repo: string | null;
  path: string | null;
  scope: KnowledgeScope;
}

export const KNOWLEDGE_LIMITS = {
  /** 1 回の生成に入れる断片の数 (既定)。 */
  maxChunks: 5,
  /** 1 回の生成に入れる断片の合計バイト。 */
  maxPromptBytes: 2400,
  /** 断片 1 件のバイト。 */
  chunkBytes: 700,
  /** 文書 1 件から作る断片の数。 */
  maxChunksPerDoc: 4,
} as const;
