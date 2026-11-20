/**
 * C-2: migration 148 の後、 provider と系統が合う委託テンプレートに世代付き ID が残らない
 * (人が固定した sol-6-1 だけは残してよい)。
 */
import type Database from "better-sqlite3";

export default {
  post(_changed: number, db: Database.Database): boolean {
    const left = db.prepare(`
      SELECT COUNT(*) AS n FROM delegation_templates
       WHERE ((target_provider = 'claude' AND (model LIKE 'claude-opus-%' OR model LIKE 'claude-sonnet-%'
               OR model LIKE 'claude-haiku-%' OR model LIKE 'claude-fable-%'))
          OR (target_provider IN ('codex', 'codex-sdk') AND model LIKE 'gpt-%'
               AND (model LIKE '%-sol' OR model LIKE '%-astra' OR model LIKE '%-luna' OR model LIKE '%-terra')))
         AND NOT (call_name = 'sol-6-1' AND id NOT IN (SELECT template_id FROM delegation_model_following))`)
      .get() as { n: number };
    return left.n === 0;
  },
};
