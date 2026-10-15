/**
 * 巡回チャットの素材 port (spec/feature/patrol-chat.md §4).
 *
 * Cc 内の port であり、 外部サービスに共通 API が存在するという意味ではない。
 * 各 adapter が所有サービスの公開契約をここへ正規化する。
 */

export type MaterialKind = "activity" | "trend" | "service-event";

export interface Material {
  sourceId: string;
  /** 話題の同一性 (同じ話題を二度使わない判定に使う)。 */
  itemId: string;
  /** 取得版。 同じ itemId でも取り直すと変わる。 */
  version: string;
  kind: MaterialKind;
  serviceCode: string;
  featureKey?: string;
  /** 出来事の時刻 (ISO8601)。 */
  occurredAt: string;
  /** Cc が観測した時刻 (ISO8601)。 */
  observedAt: string;
  title: string;
  excerpt: string;
  url?: string;
  /** 素材が属する共有範囲。 */
  scopeKey: string;
  /** この素材を出してよい宛先 scope。 */
  shareableTo: string[];
  /** 選択の補助情報 (ジャンル等)。 判定には filters で明示したものだけを使う。 */
  tags?: string[];
}

export interface SourcePage {
  items: Material[];
  cursor: string | null;
  observedAt: string;
  status: "ready" | "empty";
}

export interface SourceQuery {
  since: string;
  cursor?: string;
  limit: number;
  scopeKey: string;
  serviceCode?: string;
  featureKey?: string;
}

export interface MaterialSource {
  list(query: SourceQuery): Promise<SourcePage>;
}

/**
 * 素材取得の失敗。 空配列と混同しないため必ず throw で返す (CC-PATROL-09)。
 * - not-configured: 接続先が配られていない
 * - contract-unverified: 所有サービスの契約が未確認で選択不可
 */
export type SourceErrorCode =
  | "auth"
  | "schema"
  | "timeout"
  | "unavailable"
  | "not-configured"
  | "contract-unverified";

export class MaterialSourceError extends Error {
  constructor(readonly code: SourceErrorCode, message: string) {
    super(message);
    this.name = "MaterialSourceError";
  }
}

/** 素材取得の上限 (設計初期値)。 */
export const MATERIAL_LIMITS = {
  maxItemsPerFetch: 100,
  maxExcerptChars: 280,
  maxPromptInputBytes: 4096,
  fetchTimeoutMs: 5000,
} as const;
