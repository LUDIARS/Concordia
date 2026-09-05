/**
 * src/domain-review/types.ts — ドメインレビュー投稿の共有データ形。
 *
 * ここは「Anatomia から取れた事実」を Concordia の言葉に写しただけの型で、
 * Discord も HTTP も知らない。 描画 (embed) は chat-platform 側が持つ。
 *
 * SRP: 型定義のみ。
 *
 * @implements spec/feature/domain-review-discord.md §2.3
 */

/** 投稿の契機。 設計書 §8.2 C-4 の 3 つ。 */
export type DomainReviewTrigger = "plan" | "local-pr" | "manual";

/** 投稿対象のプロジェクト (project_codes の 1 行から作る)。 */
export interface DomainReviewTarget {
  /** project_codes.code。 */
  code: string;
  /** project_codes.project (= リポジトリ名)。 */
  project: string;
  /** project_codes.repo_path。 Anatomia の rootPath 突き合わせと plan 読み出しに使う。 */
  repoPath: string;
}

/**
 * ドメイン情報の出所。
 *  - `prepared`: web-cache の business/program-domain-view (層・関係まである本命)
 *  - `raw`: `GET /api/projects/:id/domains` の生データ (未 prepare 時のフォールバック)
 */
export type DomainReviewSource = "prepared" | "raw";

/** コアドメイン 1 件 (business-domain-view の 1 ドメイン)。 */
export interface DomainReviewCoreDomain {
  id: string;
  name: string;
  /** ドメインの説明。 未 prepare のフォールバックでは空。 */
  purpose: string;
  status: string;
  uxCritical: boolean;
  parentId: string | null;
  childIds: string[];
  /** 実装が紐付いた関数の数。 未 prepare でも取れる唯一の量。 */
  implementorCount: number | null;
  /** 宣言と実装の齟齬 (raw 応答の violationCount)。 prepared では null。 */
  violationCount: number | null;
}

/** 承認済みのコンテキストマップ辺。 */
export interface DomainReviewRelation {
  from: string;
  to: string;
  relation: string;
  rationale: string;
}

/** 層 1 つと、そこに属するプログラムドメイン。 */
export interface DomainReviewLayer {
  layer: string;
  domains: Array<{ id: string; cohesion: number | null; misfitCount: number }>;
}

/** 層をまたぐ依存のうち、宣言に反しているもの。 */
export interface DomainReviewLayerViolation {
  from: string;
  to: string;
  weight: number;
}

/** Discord へ投稿する 1 回分の材料。 */
export interface DomainReviewReport {
  target: DomainReviewTarget;
  trigger: DomainReviewTrigger;
  source: DomainReviewSource;
  /** Anatomia 側の project id (再取得や authoring の宛先に使う)。 */
  anatomiaProjectId: string;
  coreDomains: DomainReviewCoreDomain[];
  relations: DomainReviewRelation[];
  /** どのコアドメインにも属していないプログラムドメイン。 */
  unlinkedProgramDomains: string[];
  layers: DomainReviewLayer[];
  layerViolations: DomainReviewLayerViolation[];
  /** 層に分類できなかったモジュール。 */
  unclassifiedModules: string[];
  /** plan 起点の投稿だけが持つ、人間に向いた問い。 */
  planQuestions: string[];
  /** 回答の追記先 (`.anatomia/plan/<hash>.json`) を引くための hash。 */
  planTaskHash: string | null;
  /** 未 prepare など、読み手に伝える必要のある但し書き。 黙って落とさない。 */
  notes: string[];
}
