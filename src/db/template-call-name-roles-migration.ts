/**
 * 委託テンプレートの call_name をバージョン・廃止役割の無い名前へ改名する (migration 149)。
 *
 * - 行は call_name だけを書き換える (id は変えない)。 prompt 編集の記録・追随表・拠点別上書きは
 *   id で結び付いているので、そのまま付いてくる。
 * - 旧名は別名として受け付け続ける。 解決表は `src/delegation/template-call-names.ts`
 *   (alias 行は作らない。 spec/feature/model-role-map.md §委託テンプレートの名前)。
 * - 新名の行がすでにある場合は改名しない (旧名の行はそのまま残る)。
 * - 進行中・過去の run (delegation_runs.call_name) は起動時の名前の記録なので書き換えない。
 *
 * この表は適用済み migration として凍結する。 以後の改名は新しい migration で行う。
 *
 * 戻し方: 次の migration で新名 → 旧名の UPDATE を行う (解決表の向きも戻す)。
 *
 * @implements CC-MODEL-ROLE-MAP MRM-TPL-06
 */
import type Database from "better-sqlite3";

export const TEMPLATE_CALL_NAME_RENAMES_V149: ReadonlyArray<readonly [previous: string, next: string]> = [
  ["opus-5-5", "opus"],
  ["sonnet-5-5", "sonnet"],
  ["fable-5-1", "fable"],
  ["sol-6-1", "sol"],
  ["terra-xhigh", "luna-xhigh"],
  ["claude-sonnet-5-ask", "sonnet-ask"],
  ["claude-sonnet-5-walk", "sonnet-walk"],
  ["design-hard-fable5", "design-hard-fable"],
];

export function migrateTemplateCallNamesToRoles(db: Database.Database): number {
  const rename = db.prepare(`
    UPDATE delegation_templates SET call_name = ?, updated_at = ?
     WHERE call_name = ?
       AND NOT EXISTS (SELECT 1 FROM delegation_templates WHERE call_name = ?)`);
  let changed = 0;
  const now = Date.now();
  for (const [previous, next] of TEMPLATE_CALL_NAME_RENAMES_V149) {
    changed += rename.run(next, now, previous, next).changes;
  }
  return changed;
}
