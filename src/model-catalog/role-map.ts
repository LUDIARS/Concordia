/**
 * 役割 → モデル ID の対応表 (role map)。 LUDIARS の各サービスは Lapilli one-shot 経由で
 * この表を読み、 モデル ID を自前で持たない (2026-11-18 neco 指示「ハードコードを追放」)。
 *
 * - Codex: 自動更新される役割カタログ (model_role_snapshots) の現在値。
 * - Claude: モデルカタログの有効行のうち、 系統 (opus / sonnet / haiku / fable) ごとに
 *   sort_order が最小のもの。 無ければ INITIAL_CLAUDE_ROLE_MODELS。
 * - Gemini: Claude と同じ決め方で系統 neon / argon を引く。 無ければ INITIAL_GEMINI_ROLE_MODELS (MRM-GEM-01)。
 * - Grok: カタログの有効行から世代付きの Grok を選ぶ。無ければ INITIAL_GROK_ROLE_MODELS。
 *
 * @implements CC-MODEL-ROLE-MAP MRM-GEM-01
 */
import type { ModelCatalogRow } from "../db/model-catalog-repo.js";
import {
  INITIAL_CLAUDE_ROLE_MODELS, INITIAL_GEMINI_ROLE_MODELS, INITIAL_GROK_ROLE_MODELS, INITIAL_ROLE_MODELS, type RoleSnapshot,
} from "./role-policy.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:3f8a6bd6 */
import augurContract_32380cda from './grok-role-map.contract.js'; /* augur-inject:contract-predicate:2bb362f0 */

type CatalogRow = Pick<ModelCatalogRow, "provider" | "model_id" | "sort_order" | "is_active">;

export interface RoleMap {
  schemaVersion: 1;
  generatedAt: string;
  roles: { codex: Record<string, string>; claude: Record<string, string>; gemini: Record<string, string>; grok: Record<string, string> };
}

const CLAUDE_FAMILY = /^claude-(opus|sonnet|haiku|fable)-\d/;
const GEMINI_FAMILY = /^gemini-\d+(?:\.\d+)?-(neon|argon)$/;

const GROK_FAMILY = /^(grok)-\d+(?:\.\d+)?$/;

/** provider の有効行のうち、 系統 (正規表現の 1 番目の捕捉) ごとに sort_order 最小の行を採る。 無い系統は初期値。 */
export function pickCatalogFamilies(
  catalog: readonly CatalogRow[],
  provider: string,
  family: RegExp,
  initial: Readonly<Record<string, string>>,
): Record<string, string> {
  const picked: Record<string, string> = { ...initial };
  const best = new Map<string, number>();
  for (const row of catalog) {
    if (row.provider !== provider || row.is_active !== 1) continue;
    const name = family.exec(row.model_id)?.[1];
    if (!name) continue;
    const current = best.get(name);
    if (current === undefined || row.sort_order < current) {
      best.set(name, row.sort_order);
      picked[name] = row.model_id;
    }
  }
  return picked;
}

export function buildRoleMap(input: {
  roles: readonly RoleSnapshot[];
  catalog: readonly CatalogRow[];
  nowMs: number;
}): RoleMap {
  const codex: Record<string, string> = { ...INITIAL_ROLE_MODELS };
  for (const snapshot of input.roles) {
    if (snapshot.provider === "codex" && Object.hasOwn(INITIAL_ROLE_MODELS, snapshot.role)) codex[snapshot.role] = snapshot.modelId;
  }
  const claude = pickCatalogFamilies(input.catalog, "claude", CLAUDE_FAMILY, INITIAL_CLAUDE_ROLE_MODELS);
  const gemini = pickCatalogFamilies(input.catalog, "gemini", GEMINI_FAMILY, INITIAL_GEMINI_ROLE_MODELS);
  const grok = pickCatalogFamilies(input.catalog, "grok", GROK_FAMILY, INITIAL_GROK_ROLE_MODELS);
  return { schemaVersion: 1, generatedAt: new Date(input.nowMs).toISOString(), roles: { codex, claude, gemini, grok } };
}
// @ts-expect-error augur-inject
buildRoleMap = contract(buildRoleMap, { ...augurContract_32380cda, contractId: 'grok-C-1', mode: 'observe', sample: 1, where: 'src/model-catalog/role-map.ts:53', rule: 'contract-wrap', id: '32380cda' }); /* augur-inject:contract-wrap:32380cda */
