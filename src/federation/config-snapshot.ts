/**
 * 拠点へ渡せる設定を、本社 DB から最小権限で組み立てる。
 *
 * 部署外の Discord 設定は値を読まない。拠点侵害時の露出範囲を担当 guild に閉じるため、
 * allowlist 以外を後から除外する方式にはしない。
 */

import type Database from "better-sqlite3";
import type { FederationConfigSnapshot } from "./protocol.js";

export const FEDERATION_DISCORD_CONFIG_ALLOWLIST = [
  "guild_id",
  "meta_category_id",
  "sessions_category_id",
  "status_category_id",
  "archive_category_id",
  "error_category_id",
  "session_forum_id",
  "test_forum_id",
  "task_workflow_forum_id",
  "activity_channel_id",
  "cost_channel_id",
  "monitor_channel_id",
  "pr_queue_channel_id",
  "error_channel_id",
] as const;

export function createFederationConfigSnapshot(
  db: Database.Database,
  departments: readonly string[],
): FederationConfigSnapshot {
  const discord = readScopedDiscordConfig(db, departments);
  const templates = db.prepare(
    `SELECT id, call_name, title, target_provider, model
     FROM delegation_templates
     ORDER BY sort_order ASC, call_name ASC`,
  ).all() as FederationConfigSnapshot["templates"];
  return { discord, templates };
}

function readScopedDiscordConfig(
  db: Database.Database,
  departments: readonly string[],
): Record<string, string> {
  if (departments.length === 0) return {};
  // 担当かどうかを先に決め、担当外なら設定の値には触れない。読んでから捨てる形だと
  // 「担当外の設定は値を読まない」という上の約束が実装と食い違い、後から除外を
  // 1 箇所書き忘れただけで部署外の値が snapshot へ流れ込む。
  const guild = db.prepare(`SELECT value FROM discord_config WHERE key = 'guild_id'`)
    .get() as { value: string } | undefined;
  if (!guild?.value || !departments.includes(guild.value)) return {};
  const placeholders = FEDERATION_DISCORD_CONFIG_ALLOWLIST.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT key, value FROM discord_config WHERE key IN (${placeholders})`,
  ).all(...FEDERATION_DISCORD_CONFIG_ALLOWLIST) as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
