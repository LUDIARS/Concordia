/**
 * 一覧応答から session metadata の「プロンプト全文級」キーを外す.
 *
 * sessions.metadata には起動時に注入したプロンプト本文がそのまま入る。
 * 1 セッションで数 KB〜20KB になり、 一覧 (数百件) では応答の大半を占める。
 * 一覧の用途 (誰が何をしているかの俯瞰) では読まないので、 既定では落とし、
 * 落としたキー名だけを返す。 全文が要る呼び出しは単体取得
 * (GET /v1/sessions/:id) か ?metadata=full を使う。
 */

/**
 * 一覧応答から外す metadata キー。
 * いずれも「注入したプロンプト本文」であり、 構造化された判断材料ではない。
 */
export const HEAVY_SESSION_METADATA_KEYS: readonly string[] = [
  "discord_startup_task",
  "discord_startup_inject",
];

export interface SlimmedMetadata {
  metadata: Record<string, unknown> | null;
  /** 実際に落としたキー (存在したものだけ)。 */
  metadata_omitted_keys: string[];
}

/** metadata から重量キーを外し、 外したキー名を添える。 */
export function slimSessionMetadata(metadata: unknown): SlimmedMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { metadata: (metadata as Record<string, unknown> | null) ?? null, metadata_omitted_keys: [] };
  }
  const slim: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (HEAVY_SESSION_METADATA_KEYS.includes(key)) {
      omitted.push(key);
      continue;
    }
    slim[key] = value;
  }
  return { metadata: slim, metadata_omitted_keys: omitted };
}

/**
 * serializeSession 形の 1 件を一覧向けに絞る。
 * metadata 以外の形は変えない (既存の read model をそのまま使える)。
 */
export function withSlimMetadata<T extends { metadata: unknown }>(
  serialized: T,
): Omit<T, "metadata"> & SlimmedMetadata {
  const { metadata, metadata_omitted_keys } = slimSessionMetadata(serialized.metadata);
  return { ...serialized, metadata, metadata_omitted_keys };
}
