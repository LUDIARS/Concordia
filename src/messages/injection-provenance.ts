import { createHash } from "node:crypto";
import type { InjectionProvenance } from "../shared/injection-provenance.js";

/**
 * 注入 provenance を canonical message 用 metadata へ最小化する。
 * platform ID は個人情報になり得るため、生値ではなく照合用 SHA-256 reference のみ残す。
 */
export function injectionProvenanceMetadata(
  provenance: InjectionProvenance | null | undefined,
): Record<string, unknown> | undefined {
  if (!provenance) return undefined;
  return {
    injection: {
      kind: provenance.kind,
      action: provenance.action,
      platform: provenance.platform,
      ...(provenance.emoji ? { emoji: provenance.emoji } : {}),
      ...(provenance.sourceMessageId
        ? { source_message_ref: provenanceReference(provenance.platform, provenance.sourceMessageId) }
        : {}),
      ...(provenance.actorId
        ? { actor_ref: provenanceReference(provenance.platform, provenance.actorId) }
        : {}),
    },
  };
}

function provenanceReference(platform: InjectionProvenance["platform"], id: string): string {
  return `sha256:${createHash("sha256").update(`${platform}:${id}`, "utf8").digest("hex")}`;
}

/** 一覧上で直接入力と機械生成テンプレートを区別する表示名。 */
export function injectionAuthorLabel(provenance: InjectionProvenance): string {
  return `リアクション (${provenance.action})`;
}
