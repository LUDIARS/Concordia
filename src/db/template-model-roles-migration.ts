/**
 * 委託テンプレートの model をモデル ID から役割名へ移す (migration 148)。
 *
 * - claude-opus-* → opus / claude-sonnet-* → sonnet / claude-haiku-* → haiku / claude-fable-* → fable
 *   (`[1m]` 接尾辞は残す)。 provider が claude の行だけ。
 * - gpt-*-sol → sol / gpt-*-astra → astra / gpt-*-luna・gpt-*-terra → luna。 provider が codex / codex-sdk の行だけ。
 * - 人が固定した行は残す: 追随表 (delegation_model_following) から外された sol-6-1。
 *   ほかの行には固定の記録が無いので区別できない (spec/feature/model-role-map.md §委託テンプレート)。
 * - 拠点別の上書き (delegation_template_overrides.patch_json) は人の明示指定なので触らない。
 *
 * 戻し方: 役割名を当時の ID へ戻す UPDATE を次の migration で行う (role map の値で埋めればよい)。
 *
 * @implements CC-MODEL-ROLE-MAP MRM-TPL-04
 */
import { contract } from './ontime-runtime.js'; /* augur-inject:import:9a4f2c71 */
import augurContract_c58e17b2 from './template-model-roles-migration.contract.js'; /* augur-inject:contract-predicate:c58e17b2 */
import type Database from "better-sqlite3";

const CLAUDE_ROLES = ["opus", "sonnet", "haiku", "fable"] as const;
const CODEX_ROLES: ReadonlyArray<[pattern: string, role: string]> = [
  ["%-sol", "sol"], ["%-astra", "astra"], ["%-luna", "luna"], ["%-terra", "luna"],
];

export function migrateTemplateModelsToRoles(db: Database.Database): number {
  const pinned = `NOT (call_name = 'sol-6-1' AND id NOT IN (SELECT template_id FROM delegation_model_following))`;
  let changed = 0;
  for (const role of CLAUDE_ROLES) {
    changed += db.prepare(`
      UPDATE delegation_templates
         SET model = ? || CASE WHEN model LIKE '%[1m]' THEN '[1m]' ELSE '' END
       WHERE target_provider = 'claude' AND model LIKE ? AND ${pinned}`)
      .run(role, `claude-${role}-%`).changes;
  }
  for (const [suffix, role] of CODEX_ROLES) {
    changed += db.prepare(`
      UPDATE delegation_templates SET model = ?
       WHERE target_provider IN ('codex', 'codex-sdk') AND model LIKE 'gpt-%' AND model LIKE ? AND ${pinned}`)
      .run(role, suffix).changes;
  }
  return changed;
}
// @ts-expect-error augur-inject
migrateTemplateModelsToRoles = contract(migrateTemplateModelsToRoles, { ...augurContract_c58e17b2, contractId: 'model-role-tpl-C-2', mode: 'observe', sample: 1, where: 'src/db/template-model-roles-migration.ts:26', rule: 'contract-wrap', id: 'c58e17b2' }); /* augur-inject:contract-wrap:c58e17b2 */
