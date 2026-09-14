import { z } from "zod";
import {
  SUBSIDIARY_SCOPES,
  normalizeNotificationPolicy,
  parseNotificationPolicy,
  serializeNotificationPolicy,
  type ProjectNotificationPolicy,
  type SubsidiaryScope,
} from "../deploy/notification-target-policy.js";

/**
 * project registry 管理面のプロジェクト別通知設定 (入力検証・表示形・保存形への変換)。
 * 扱うのは範囲の選択だけで、Webhook URL・Bot token など配送の秘密は読まず返さない。
 * @implements spec/feature/project-notification-preferences.md — 管理 API
 */

export const NotificationPreferenceSchema = z.object({
  enabled: z.boolean(),
  hq: z.boolean(),
  subsidiary_scope: z.enum(SUBSIDIARY_SCOPES),
  subsidiary_ids: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
}).strict();

export type NotificationPreferenceInput = z.infer<typeof NotificationPreferenceSchema>;

export interface NotificationPreferenceView {
  /** false は未設定。 このとき他の値は現行の配送規則 (本社＋運用対象の子会社) を表す。 */
  configured: boolean;
  enabled: boolean;
  hq: boolean;
  subsidiary_scope: SubsidiaryScope;
  subsidiary_ids: string[];
}

export function toNotificationPreferenceView(raw: string | null | undefined): NotificationPreferenceView {
  const policy = parseNotificationPolicy(raw);
  if (!policy) return { configured: false, enabled: true, hq: true, subsidiary_scope: "operating", subsidiary_ids: [] };
  return {
    configured: true,
    enabled: policy.enabled,
    hq: policy.hq,
    subsidiary_scope: policy.subsidiaryScope,
    subsidiary_ids: policy.subsidiaryIds,
  };
}

/** 省略されたイベントは undefined のまま返し、保存済みの設定を変えない (イベント間の独立)。 */
export function serializeNotificationPreference(input: NotificationPreferenceInput | undefined): string | undefined {
  return input === undefined ? undefined : serializeNotificationPolicy(toNotificationPolicy(input));
}

/**
 * 個別選択の子会社 ID が登録済みか。 未知の ID を受けると、選んだつもりの宛先が最初から
 * 存在しない設定になるので保存を拒否する (配送時も登録済みの有効な子会社だけに絞る)。
 */
export function findUnregisteredSubsidiary(
  inputs: ReadonlyArray<NotificationPreferenceInput | undefined>,
  registry: { find: (id: string) => unknown } | undefined,
): { error: "subsidiary_registry_unavailable" | "subsidiary_not_found" } | null {
  const ids = inputs.flatMap((input) => (input ? toNotificationPolicy(input).subsidiaryIds : []));
  if (ids.length === 0) return null;
  if (!registry) return { error: "subsidiary_registry_unavailable" };
  return ids.some((id) => !registry.find(id)) ? { error: "subsidiary_not_found" } : null;
}

function toNotificationPolicy(input: NotificationPreferenceInput): ProjectNotificationPolicy {
  return normalizeNotificationPolicy({
    enabled: input.enabled,
    hq: input.hq,
    subsidiaryScope: input.subsidiary_scope,
    subsidiaryIds: input.subsidiary_ids,
  });
}
