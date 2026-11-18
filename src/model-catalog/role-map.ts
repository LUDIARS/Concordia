/**
 * 役割 → モデル ID の対応表 (role map)。 LUDIARS の各サービスは Lapilli one-shot 経由で
 * この表を読み、 モデル ID を自前で持たない (2026-11-18 neco 指示「ハードコードを追放」)。
 *
 * - Codex: 自動更新される役割カタログ (model_role_snapshots) の現在値。
 * - Claude: モデルカタログの有効行のうち、 系統 (opus / sonnet / haiku / fable) ごとに
 *   sort_order が最小のもの。 無ければ INITIAL_CLAUDE_ROLE_MODELS。
 *
 * @implements CC-MODEL-ROLE-MAP
 */
import type { ModelCatalogRow } from "../db/model-catalog-repo.js";
import { INITIAL_CLAUDE_ROLE_MODELS, INITIAL_ROLE_MODELS, type RoleSnapshot } from "./role-policy.js";

export interface RoleMap {
  schemaVersion: 1;
  generatedAt: string;
  roles: { codex: Record<string, string>; claude: Record<string, string> };
}

const CLAUDE_FAMILY = /^claude-(opus|sonnet|haiku|fable)-\d/;

export function buildRoleMap(input: {
  roles: readonly RoleSnapshot[];
  catalog: readonly Pick<ModelCatalogRow, "provider" | "model_id" | "sort_order" | "is_active">[];
  nowMs: number;
}): RoleMap {
  const codex: Record<string, string> = { ...INITIAL_ROLE_MODELS };
  for (const snapshot of input.roles) {
    if (snapshot.provider === "codex" && Object.hasOwn(INITIAL_ROLE_MODELS, snapshot.role)) codex[snapshot.role] = snapshot.modelId;
  }
  const claude: Record<string, string> = { ...INITIAL_CLAUDE_ROLE_MODELS };
  const best = new Map<string, number>();
  for (const row of input.catalog) {
    if (row.provider !== "claude" || row.is_active !== 1) continue;
    const family = CLAUDE_FAMILY.exec(row.model_id)?.[1];
    if (!family) continue;
    const current = best.get(family);
    if (current === undefined || row.sort_order < current) {
      best.set(family, row.sort_order);
      claude[family] = row.model_id;
    }
  }
  return { schemaVersion: 1, generatedAt: new Date(input.nowMs).toISOString(), roles: { codex, claude } };
}
