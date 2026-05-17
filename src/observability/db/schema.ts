/**
 * Observability (Excubitor 由来) の Drizzle SQLite スキーマ.
 *
 * 物理スキーマ自体は src/db/schema.ts の applyMigrations() で投入される.
 * 本ファイルは drizzle-orm 経由で型安全に SELECT/INSERT/UPDATE するための型定義.
 *
 * 元 Excubitor は drizzle-orm/pg-core + Postgres. SQLite 化に伴い以下を変換:
 *   - UUID         → text PK + app 側 crypto.randomUUID()
 *   - JSONB        → text (JSON string)
 *   - BOOLEAN      → integer({ mode: 'boolean' })
 *   - TIMESTAMPTZ  → integer({ mode: 'timestamp_ms' })
 *   - TEXT[]       → text (JSON array)
 *   - BIGSERIAL    → integer PK AUTOINCREMENT
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';

export const hosts = sqliteTable('hosts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  hostname: text('hostname').notNull(),
  agent_version: text('agent_version'),
  last_heartbeat_at: integer('last_heartbeat_at', { mode: 'timestamp_ms' }),
  is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const services = sqliteTable('services', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  catalog_snapshot: text('catalog_snapshot', { mode: 'json' }).notNull(),
  is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const serviceInstances = sqliteTable('service_instances', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  service_id: text('service_id').notNull().references(() => services.id),
  host_id: text('host_id').references(() => hosts.id),
  pid: integer('pid'),
  docker_id: text('docker_id'),
  state: text('state').notNull().default('unknown'),
  last_seen_at: integer('last_seen_at', { mode: 'timestamp_ms' }),
  started_at: integer('started_at', { mode: 'timestamp_ms' }),
  exit_code: integer('exit_code'),
  git_branch: text('git_branch'),
  git_hash: text('git_hash'),
  git_dirty: integer('git_dirty', { mode: 'boolean' }),
  package_version: text('package_version'),
  port: integer('port'),
  extra: text('extra', { mode: 'json' }),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const livenessHistory = sqliteTable('liveness_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  service_instance_id: text('service_instance_id').notNull().references(() => serviceInstances.id),
  probed_at: integer('probed_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  latency_ms: integer('latency_ms'),
  detail: text('detail', { mode: 'json' }),
});

// Excubitor の process_logs を rename. Concordia の processes (managed processes)
// 由来の process_logs と別物.
export const serviceInstanceLogs = sqliteTable('service_instance_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  service_instance_id: text('service_instance_id').notNull().references(() => serviceInstances.id),
  ts: integer('ts', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  level: text('level'),
  line: text('line').notNull(),
});

export const errorRules = sqliteTable('error_rules', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  pattern: text('pattern').notNull(),
  pattern_type: text('pattern_type').notNull().default('regex'),
  severity: text('severity').notNull().default('error'),
  // 元 TEXT[]. JSON 配列文字列で持つ. アプリ側で JSON.parse/stringify.
  service_codes: text('service_codes', { mode: 'json' }),
  is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const errorTasks = sqliteTable('error_tasks', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  rule_id: text('rule_id').references(() => errorRules.id),
  service_instance_id: text('service_instance_id').references(() => serviceInstances.id),
  severity: text('severity').notNull().default('error'),
  summary: text('summary').notNull(),
  log_excerpt: text('log_excerpt'),
  occurrence_count: integer('occurrence_count').notNull().default(1),
  first_seen_at: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  last_seen_at: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  state: text('state').notNull().default('open'),
  snooze_until: integer('snooze_until', { mode: 'timestamp_ms' }),
  triaged_by: text('triaged_by'),
  triaged_at: integer('triaged_at', { mode: 'timestamp_ms' }),
  note: text('note'),
  auto_fix_state: text('auto_fix_state'),
  auto_fix_attempts: integer('auto_fix_attempts').notNull().default(0),
  auto_fix_run_id: text('auto_fix_run_id'),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const autoFixRuns = sqliteTable('auto_fix_runs', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  error_task_id: text('error_task_id').notNull().references(() => errorTasks.id),
  service_code: text('service_code').notNull(),
  agent: text('agent').notNull().default('claude-code'),
  state: text('state').notNull().default('pending'),
  triggered_by: text('triggered_by'),
  prompt: text('prompt'),
  started_at: integer('started_at', { mode: 'timestamp_ms' }),
  finished_at: integer('finished_at', { mode: 'timestamp_ms' }),
  exit_code: integer('exit_code'),
  stdout_tail: text('stdout_tail'),
  stderr_tail: text('stderr_tail'),
  branch: text('branch'),
  commit_hash: text('commit_hash'),
  pr_url: text('pr_url'),
  verify_result: text('verify_result'),
  error_message: text('error_message'),
  action_type: text('action_type').notNull().default('fix'),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  actor: text('actor'),
  action: text('action').notNull(),
  target_type: text('target_type'),
  target_id: text('target_id'),
  payload: text('payload', { mode: 'json' }),
});
