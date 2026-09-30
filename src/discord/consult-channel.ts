/**
 * プライベート相談のチャンネル名 (spec/feature/tech-consultation.md §4)。
 *
 * チャンネルの作成・閲覧者の付け外し・終了時の書き込み停止は、 報告用のプライベートチャンネルと共通の
 * `private-channel-discord.ts` が持つ (spec/feature/private-channels.md §1)。 ここは相談に固有の名前だけ。
 * 名前は内容を含めない (`相談-<日付>-<短い id>`)。
 *
 * @implements SPEC-CONSULT-PRIVATE
 */

export function privateConsultChannelName(now: Date, consultationId: string): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = consultationId.replace(/^pc_/, "").slice(0, 6);
  return `相談-${date}-${suffix}`;
}
