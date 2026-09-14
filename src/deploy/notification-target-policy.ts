import { isProjectNameInScope } from "../subsidiary/project-scope.js";

/**
 * プロジェクト別の通知ポリシー (デプロイ / リリースで独立) の解釈と、子会社を配送範囲に含めるかの判定。
 *
 * 保存 (project registry)・管理 API・配送先の解決が同じ規則を読むので、I/O を持たない純関数に閉じる。
 * @implements spec/feature/project-notification-preferences.md
 */

export const SUBSIDIARY_SCOPES = ["none", "operating", "all", "selected"] as const;
export type SubsidiaryScope = (typeof SUBSIDIARY_SCOPES)[number];

export interface ProjectNotificationPolicy {
  /** false はこのイベントを本社・子会社・追加宛先のどこにも送らない。 */
  enabled: boolean;
  /** 本社の宛先 (専用チャンネル・設定済み webhook) を含むか。 */
  hq: boolean;
  subsidiaryScope: SubsidiaryScope;
  /** `selected` のときだけ意味を持つ。 それ以外の範囲では常に空。 */
  subsidiaryIds: string[];
}

/** 保存形式 (`project_codes.deploy_notification` / `release_notification` の JSON)。 */
export interface StoredNotificationPolicy {
  enabled: boolean;
  hq: boolean;
  subsidiary_scope: SubsidiaryScope;
  subsidiary_ids: string[];
}

/** 範囲判定に要る子会社の属性だけ。 Bot token や webhook URL は持ち込まない。 */
export interface SubsidiaryScopeCandidate {
  subsidiaryId: string;
  enabled: boolean;
  /** 通知対象 project (`subsidiary_deploy_projects`)。 関係 project ではない。 */
  projects: readonly string[];
}

export function normalizeNotificationPolicy(policy: ProjectNotificationPolicy): ProjectNotificationPolicy {
  const subsidiaryIds = policy.subsidiaryScope === "selected"
    ? [...new Set(policy.subsidiaryIds.map((id) => id.trim()).filter(Boolean))]
    : [];
  return { enabled: policy.enabled, hq: policy.hq, subsidiaryScope: policy.subsidiaryScope, subsidiaryIds };
}

/**
 * 保存値を解釈する。 null / undefined は未設定で、呼び出し側は現行の配送規則を使う。
 * 明示設定が読めない (壊れた JSON・未知の範囲) ときは旧規則へ戻さず無効として扱う —
 * 保存した設定より広い宛先へ黙って配らないため。
 */
export function parseNotificationPolicy(raw: string | null | undefined): ProjectNotificationPolicy | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return disabledPolicy();
  }
  if (!isStoredPolicy(value)) return disabledPolicy();
  return normalizeNotificationPolicy({
    enabled: value.enabled,
    hq: value.hq,
    subsidiaryScope: value.subsidiary_scope,
    subsidiaryIds: value.subsidiary_ids,
  });
}

export function serializeNotificationPolicy(policy: ProjectNotificationPolicy): string {
  const normalized = normalizeNotificationPolicy(policy);
  const stored: StoredNotificationPolicy = {
    enabled: normalized.enabled,
    hq: normalized.hq,
    subsidiary_scope: normalized.subsidiaryScope,
    subsidiary_ids: normalized.subsidiaryIds,
  };
  return JSON.stringify(stored);
}

/**
 * 明示ポリシーでこの子会社へ配るか。 候補は登録済みの子会社だけで、無効な子会社には
 * どの範囲でも配らない。 `operating` は通知対象 project の所属、`selected` は選んだ ID で決める。
 */
export function isSubsidiaryInPolicyScope(
  policy: ProjectNotificationPolicy,
  project: string,
  candidate: SubsidiaryScopeCandidate,
): boolean {
  if (!policy.enabled || !candidate.enabled) return false;
  switch (policy.subsidiaryScope) {
    case "none": return false;
    case "operating": return isProjectNameInScope(project, candidate.projects);
    case "all": return true;
    case "selected": return policy.subsidiaryIds.includes(candidate.subsidiaryId);
  }
}

function disabledPolicy(): ProjectNotificationPolicy {
  return { enabled: false, hq: false, subsidiaryScope: "none", subsidiaryIds: [] };
}

function isStoredPolicy(value: unknown): value is StoredNotificationPolicy {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.enabled === "boolean"
    && typeof row.hq === "boolean"
    && (SUBSIDIARY_SCOPES as readonly unknown[]).includes(row.subsidiary_scope)
    && Array.isArray(row.subsidiary_ids)
    && row.subsidiary_ids.every((id) => typeof id === "string");
}
