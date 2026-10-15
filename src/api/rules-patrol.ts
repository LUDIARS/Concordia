/**
 * /v1/rules の巡回チャット追加 route (spec/feature/patrol-chat.md §9)。
 *
 *   GET  /sources            登録素材元と ready/unavailable・最終取得
 *   POST /preview            副作用・LLM なしで候補と理由を返す
 *   GET  /runs               実行履歴 (cursor 付き)
 *   GET  /runs/:runId        選択根拠・本文・配達・会話・版
 *   POST /service-events     正規化済み service event を受信箱へ (source_event_id で一度だけ)
 *   GET  /:id/versions       版履歴
 *   POST /:id/rollback       指定版の定義を新しい版として復元 (設定のみ。 過去の投稿は変えない)
 */

import type { Hono } from "hono";
import { z } from "zod";
import type { RuleConversationsRepo } from "../db/rule-conversations-repo.js";
import type { RuleRunsRepo, RunStatus } from "../db/rule-runs-repo.js";
import type { RuleServiceEventsRepo } from "../db/rule-service-events-repo.js";
import type { RuleDefinitionSnapshot, RuleVersionsRepo } from "../db/rule-versions-repo.js";
import type { RuleRow, RulesRepo } from "../db/rules-repo.js";
import type { MaterialSourceRegistry } from "../rules/material-registry.js";
import { KNOWN_PATROL_SCOPES } from "../rules/patrol-config.js";
import { previewPatrolRule } from "../rules/patrol-preview.js";
import { validateRuleDefinition } from "../rules/rule-validation.js";
import type { SubsidiaryPatrolDefaults } from "../rules/patrol-config.js";
import { eventBus } from "../events.js";

export interface PatrolApiDeps {
  runs: RuleRunsRepo;
  conversations: RuleConversationsRepo;
  events: RuleServiceEventsRepo;
  sources: MaterialSourceRegistry;
}

const RUN_STATUSES: readonly RunStatus[] = [
  "claimed", "material_selected", "rendering", "rendered", "delivery_pending",
  "delivered", "delivery_unknown", "skipped", "failed",
];

const PreviewSchema = z.object({
  rule_id: z.string().min(1).max(64).optional(),
  action_config: z.record(z.unknown()).optional(),
  seed: z.number().int().min(0).max(0xffffffff).optional(),
}).refine((v) => v.rule_id || v.action_config, { message: "rule_id or action_config is required" });

const ServiceEventSchema = z.object({
  source_event_id: z.string().min(1).max(200),
  service_code: z.string().min(1).max(20),
  feature_key: z.string().min(1).max(60).nullable().optional(),
  event_kind: z.string().min(1).max(60),
  title: z.string().min(1).max(200),
  summary: z.string().max(500).optional(),
  url: z.string().url().max(500).nullable().optional(),
  scope_key: z.string().min(1).max(40),
  occurred_at: z.number().int().positive().optional(),
});

const RollbackSchema = z.object({
  expected_revision: z.number().int().min(1),
  to_revision: z.number().int().min(1),
});

function nowSec(): number { return Math.floor(Date.now() / 1000); }

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export function registerPatrolRoutes(
  app: Hono,
  deps: PatrolApiDeps & {
    rules: RulesRepo;
    versions: RuleVersionsRepo | null;
    serializeRule: (r: RuleRow) => unknown;
    /** 持ち主の子会社の既定値 (本社は null)。 */
    inheritFor?: (subsidiaryId: string | null) => SubsidiaryPatrolDefaults | null;
  },
): void {
  app.get("/sources", (c) => c.json({ sources: deps.sources.statuses() }));

  app.post("/preview", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PreviewSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const rule = parsed.data.rule_id ? deps.rules.find(parsed.data.rule_id) : null;
    if (parsed.data.rule_id && !rule) return c.json({ error: "not_found" }, 404);
    const actionConfig = parsed.data.action_config ? JSON.stringify(parsed.data.action_config) : rule?.action_config ?? null;
    const nowMs = Date.now();
    const result = await previewPatrolRule(
      { id: rule?.id ?? "(draft)", action_config: actionConfig },
      {
        sources: deps.sources,
        usedItemIds: rule ? deps.runs.usedItemIds(rule.id, Math.floor(nowMs / 1000) - 30 * 86400) : new Set(),
        nowMs,
        seed: parsed.data.seed ?? Math.floor(Math.random() * 0x1_0000_0000),
      },
    );
    return c.json({ preview: result });
  });

  app.get("/runs", (c) => {
    const status = c.req.query("status");
    if (status && !(RUN_STATUSES as readonly string[]).includes(status)) return c.json({ error: "invalid status" }, 400);
    const rawLimit = Number(c.req.query("limit") ?? "50");
    const page = deps.runs.list({
      rule_id: c.req.query("rule_id") || undefined,
      status: (status as RunStatus) || undefined,
      cursor: c.req.query("cursor") || null,
      limit: Number.isInteger(rawLimit) ? rawLimit : 50,
    });
    return c.json({ runs: page.runs.map(serializeRun), next_cursor: page.next_cursor });
  });

  app.get("/runs/:runId", (c) => {
    const run = deps.runs.find(c.req.param("runId"));
    if (!run) return c.json({ error: "not_found" }, 404);
    const conv = run.conversation_id ? deps.conversations.find(run.conversation_id) : null;
    const version = deps.versions?.find(run.rule_id, run.rule_revision) ?? null;
    return c.json({
      run: serializeRun(run),
      conversation: conv
        ? { ...conv, inbound: deps.conversations.listInbound(conv.conversation_id) }
        : null,
      rule_version: version ? { revision: version.revision, snapshot: parseJson(version.snapshot), created_at: version.created_at } : null,
    });
  });

  app.post("/service-events", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ServiceEventSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const e = parsed.data;
    if (!(KNOWN_PATROL_SCOPES as readonly string[]).includes(e.scope_key)) {
      return c.json({ error: "unknown scope_key", allowed: KNOWN_PATROL_SCOPES }, 422);
    }
    const now = nowSec();
    const row = deps.events.receive({
      source_event_id: e.source_event_id,
      service_code: e.service_code,
      feature_key: e.feature_key ?? null,
      event_kind: e.event_kind,
      title: e.title,
      summary: e.summary ?? "",
      url: e.url ?? null,
      scope_key: e.scope_key,
      occurred_at: e.occurred_at ?? now,
    }, now);
    // 同じ event の再送は受理済みとして 200 を返す (送り手の再試行を安全にする)。
    return c.json({ accepted: row !== null, duplicate: row === null, event_id: row?.id ?? null });
  });

  app.get("/:id/versions", (c) => {
    if (!deps.versions) return c.json({ versions: [] });
    const rows = deps.versions.list(c.req.param("id"));
    return c.json({
      versions: rows.map((v) => ({ revision: v.revision, actor: v.actor, note: v.note, created_at: v.created_at, snapshot: parseJson(v.snapshot) })),
    });
  });

  app.post("/:id/rollback", async (c) => {
    if (!deps.versions) return c.json({ error: "versions_unavailable" }, 503);
    const id = c.req.param("id");
    const cur = deps.rules.find(id);
    if (!cur || cur.removed_at) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = RollbackSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (parsed.data.expected_revision !== cur.revision) return c.json({ error: "revision_conflict", revision: cur.revision }, 409);
    const target = deps.versions.find(id, parsed.data.to_revision);
    if (!target) return c.json({ error: "revision_not_found" }, 404);
    const snap = JSON.parse(target.snapshot) as RuleDefinitionSnapshot;
    // 持ち主は版の対象外 (戻しても今の持ち主のまま)。 その子会社の既定値で検証する。
    const review = validateRuleDefinition(
      { id, ...snap, subsidiary_id: cur.subsidiary_id },
      deps.sources,
      deps.inheritFor?.(cur.subsidiary_id) ?? null,
    );
    if (!review.ok) return c.json({ error: "rule_review_failed", reason: review.reason }, 422);
    const updated = deps.rules.updateWithRevision(id, cur.revision, {
      description: snap.description,
      trigger_type: snap.trigger_type,
      tick_sec: snap.tick_sec,
      event_kind: snap.event_kind,
      conditions: snap.conditions,
      instructions: snap.instructions,
      target: snap.target,
      cooldown_sec: snap.cooldown_sec,
      config_version: snap.config_version,
      execution_mode: snap.execution_mode,
      action_config: snap.action_config,
    });
    if (!updated) return c.json({ error: "revision_conflict", revision: deps.rules.find(id)?.revision ?? null }, 409);
    // 有効/無効は rollback で変えない (無効化は固定版より優先する)。 定義だけを戻す。
    deps.rules.setNextDue(id, null);
    deps.versions.record(updated, "human", `rollback to rev ${parsed.data.to_revision}`);
    deps.rules.log({ rule_id: id, action: "add", actor: "human", detail: `rollback to rev ${parsed.data.to_revision} (now rev ${updated.revision})` });
    eventBus.emit({ type: "rule.changed", rule_id: id, action: "toggle", ts: nowSec() });
    return c.json({ rule: deps.serializeRule(updated) });
  });
}

function serializeRun(r: ReturnType<RuleRunsRepo["find"]> & object) {
  return {
    run_id: r.run_id,
    rule_id: r.rule_id,
    rule_revision: r.rule_revision,
    trigger_key: r.trigger_key,
    action_kind: r.action_kind,
    conversation_id: r.conversation_id,
    scope_key: r.scope_key,
    channel: r.channel,
    source_ref: r.source_ref,
    material: parseJson(r.material_snapshot),
    seed: r.seed,
    decision: parseJson(r.decision),
    reason: r.reason,
    status: r.status,
    render_attempts: r.render_attempts,
    llm_calls: r.llm_calls,
    rendered_text: r.rendered_text,
    chat_message_id: r.chat_message_id,
    delivery_ref: r.delivery_ref,
    error_code: r.error_code,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
