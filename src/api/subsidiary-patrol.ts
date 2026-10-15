/**
 * 子会社単位の巡回チャット API (spec/plan/2026-10-15-patrol-subsidiary-rules-design.md §2 §3)。
 *
 * - GET/PUT `/v1/subsidiaries/:id/patrol-defaults`  子会社ごとの既定値
 * - GET     `/v1/subsidiaries/:id/patrol/rules`      その子会社の巡回 rule
 * - POST    `/v1/subsidiaries/:id/patrol/rules`      トレンド巡回を 1 本追加 (公開トレンド・public 固定)
 * - PATCH   `/v1/subsidiaries/:id/patrol/rules/:ruleId`         間隔・上限・時間帯・指示・投稿先・名前の雰囲気
 * - POST    `/v1/subsidiaries/:id/patrol/rules/:ruleId/toggle`  有効 / 無効
 *
 * 子会社サーバー管理者の `/patrol` (Discord) はここだけを呼ぶ。 rule の持ち主が :id と一致しなければ 404
 * (別の子会社や本社の rule を触らせない)。 素材元・scope・持ち主はここからは変えられない。
 * loopback 信頼境界 (subsidiary-delegation.md §5)。 誰が変えたかは actor で受け取り、 版と rule_log に残す。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RuleRow, RulesRepo } from "../db/rules-repo.js";
import type { RuleVersionsRepo } from "../db/rule-versions-repo.js";
import type { SubsidiaryPatrolDefaultsRepo } from "../db/subsidiary-patrol-defaults-repo.js";
import { eventBus } from "../events.js";
import {
  GLOBAL_PATROL_DEFAULTS,
  parseActionConfig,
  parseSubsidiaryDefaults,
  type SourceLookup,
  type SubsidiaryPatrolDefaults,
} from "../rules/patrol-config.js";
import { TENDENTIA_SOURCE_ID } from "../rules/material-tendentia.js";
import { validateRuleDefinition, type RuleDefinition } from "../rules/rule-validation.js";

export interface SubsidiaryPatrolApiDeps {
  rules: RulesRepo;
  versions: RuleVersionsRepo | null;
  defaults: SubsidiaryPatrolDefaultsRepo;
  sources: SourceLookup;
  /** 子会社の存在と名前 (rule ID の接頭辞に使う)。 */
  subsidiary: (id: string) => { name: string } | null;
  serializeRule: (r: RuleRow) => unknown;
  /** 有効化・停止した rule の進行中 run を見送りにする。 */
  cancelInFlight?: (ruleId: string, reason: string, now: number) => void;
}

const nowSec = () => Math.floor(Date.now() / 1000);

const Actor = z.string().trim().min(1).max(120);
const QuietHours = z.union([z.literal("inherit"), z.object({ start: z.string(), end: z.string() }).strict(), z.null()]);

const DefaultsPut = z.object({ actor: Actor, defaults: z.record(z.unknown()) });

const RuleCreate = z.object({
  actor: Actor,
  /** 投稿先 (この子会社の guild のチャンネル)。 省略時は子会社の既定値。 */
  discord_channel_id: z.string().regex(/^\d{17,20}$/).optional(),
  tick_sec: z.number().int().min(600).max(86400).default(1800),
  instructions: z.string().trim().min(1).max(400).default("トレンドの話題を1件、雑談として短く紹介する。"),
  description: z.string().trim().max(120).optional(),
});

/** 子会社から変えられる項目だけ。 素材元・scope・持ち主は変えない。 */
const RulePatch = z.object({
  actor: Actor,
  tick_sec: z.number().int().min(600).max(86400).optional(),
  instructions: z.string().trim().min(1).max(400).optional(),
  description: z.string().trim().max(120).nullable().optional(),
  root_limit_per_day: z.number().int().min(1).max(48).nullable().optional(),
  quiet_hours: QuietHours.optional(),
  discord_channel_id: z.string().regex(/^\d{17,20}$/).nullable().optional(),
  persona_hint: z.string().trim().min(1).max(80).nullable().optional(),
}).strict();

const Toggle = z.object({ actor: Actor, enabled: z.boolean() });

/** PATCH の null は「rule の指定を外して子会社の既定値に戻す」(action_config からキーを消す)。 */
function applyInheritedField(config: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) return;
  if (value === null) delete config[key];
  else config[key] = value;
}

export function subsidiaryPatrolRouter(deps: SubsidiaryPatrolApiDeps): Hono {
  const app = new Hono();
  const inherit = (id: string): SubsidiaryPatrolDefaults | null => {
    const row = deps.defaults.get(id);
    const parsed = row ? parseSubsidiaryDefaults(row.config) : null;
    return parsed?.ok ? parsed.defaults : null;
  };
  const ownedRule = (id: string, ruleId: string): RuleRow | null => {
    const rule = deps.rules.find(ruleId);
    return rule && !rule.removed_at && rule.subsidiary_id === id && rule.config_version === 2 ? rule : null;
  };

  app.get("/:id/patrol-defaults", (c) => {
    const id = c.req.param("id");
    if (!deps.subsidiary(id)) return c.json({ error: "not_found" }, 404);
    const row = deps.defaults.get(id);
    const defaults = inherit(id) ?? {};
    return c.json({
      defaults,
      effective: { ...GLOBAL_PATROL_DEFAULTS, paused: false, ...defaults },
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null,
    });
  });

  app.put("/:id/patrol-defaults", async (c) => {
    const id = c.req.param("id");
    if (!deps.subsidiary(id)) return c.json({ error: "not_found" }, 404);
    const body = DefaultsPut.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const parsed = parseSubsidiaryDefaults(body.data.defaults);
    if (!parsed.ok) return c.json({ error: "invalid_defaults", reason: parsed.reason }, 400);
    const row = deps.defaults.set(id, JSON.stringify(parsed.defaults), body.data.actor, nowSec());
    deps.rules.log({ rule_id: null, action: "add", actor: "human", detail: `patrol defaults of ${id} set by ${body.data.actor}` });
    return c.json({ defaults: parsed.defaults, updated_at: row.updated_at, updated_by: row.updated_by });
  });

  app.get("/:id/patrol/rules", (c) => {
    const id = c.req.param("id");
    if (!deps.subsidiary(id)) return c.json({ error: "not_found" }, 404);
    const rules = deps.rules.list({ subsidiary_id: id, execution_mode: "patrol" }).filter((r) => !r.removed_at);
    return c.json({ rules: rules.map(deps.serializeRule) });
  });

  app.post("/:id/patrol/rules", async (c) => {
    const id = c.req.param("id");
    const sub = deps.subsidiary(id);
    if (!sub) return c.json({ error: "not_found" }, 404);
    const body = RuleCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const b = body.data;
    const action: Record<string, unknown> = {
      kind: "material-chat",
      source_ids: [TENDENTIA_SOURCE_ID],
      scope_key: "public",
      filters: { max_age_sec: 86400 },
      ...(b.discord_channel_id ? { discord_channel_id: b.discord_channel_id } : {}),
    };
    const existing = new Set(deps.rules.list({ subsidiary_id: id }).map((r) => r.id));
    let n = 1;
    while (existing.has(`${sub.name}-trend-${n}`) || deps.rules.find(`${sub.name}-trend-${n}`)) n++;
    const def: RuleDefinition = {
      id: `${sub.name}-trend-${n}`.slice(0, 64),
      description: b.description ?? "トレンド巡回",
      trigger_type: "tick",
      tick_sec: b.tick_sec,
      event_kind: null,
      conditions: "[]",
      instructions: b.instructions,
      target: "chitchat",
      cooldown_sec: b.tick_sec,
      config_version: 2,
      execution_mode: "patrol",
      action_config: JSON.stringify(action),
      subsidiary_id: id,
    };
    const defaults = inherit(id);
    const review = validateRuleDefinition(def, deps.sources, defaults);
    if (!review.ok) return c.json({ error: "rule_review_failed", reason: review.reason }, 422);
    const effective = parseActionConfig(def.action_config, defaults);
    if (effective.ok && !effective.config.discord_channel_id) {
      return c.json({ error: "rule_review_failed", reason: "投稿先チャンネルが決まっていない (指定するか、 子会社の既定値に設定する)" }, 422);
    }
    // 子会社の管理者が自分で追加した rule は、 検証を通れば有効で保存する。
    const inserted = deps.rules.insert({
      id: def.id, description: def.description, trigger_type: "tick", tick_sec: def.tick_sec, event_kind: null,
      conditions: def.conditions, instructions: def.instructions, target: def.target, cooldown_sec: def.cooldown_sec,
      added_by: "human", enabled: true, config_version: 2, execution_mode: "patrol", action_config: def.action_config,
      subsidiary_id: id,
    });
    deps.versions?.record(inserted, b.actor, "created by subsidiary");
    deps.rules.log({ rule_id: inserted.id, action: "add", actor: "human", detail: `added by ${b.actor} (subsidiary ${id})` });
    eventBus.emit({ type: "rule.changed", rule_id: inserted.id, action: "add", ts: nowSec() });
    return c.json({ rule: deps.serializeRule(inserted) });
  });

  app.patch("/:id/patrol/rules/:ruleId", async (c) => {
    const id = c.req.param("id");
    const cur = ownedRule(id, c.req.param("ruleId"));
    if (!cur) return c.json({ error: "not_found" }, 404);
    const body = RulePatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const p = body.data;
    let config: Record<string, unknown>;
    try { config = JSON.parse(cur.action_config ?? "{}") as Record<string, unknown>; } catch { config = {}; }
    applyInheritedField(config, "root_limit_per_day", p.root_limit_per_day);
    // quiet_hours: "inherit" で子会社の既定値に戻す、 null で「時間帯なし」を明示、 {start,end} で指定。
    if (p.quiet_hours === "inherit") delete config.quiet_hours;
    else if (p.quiet_hours !== undefined) config.quiet_hours = p.quiet_hours;
    applyInheritedField(config, "discord_channel_id", p.discord_channel_id);
    applyInheritedField(config, "persona_hint", p.persona_hint);
    const merged: RuleDefinition = {
      id: cur.id,
      description: p.description !== undefined ? p.description : cur.description,
      trigger_type: cur.trigger_type,
      tick_sec: p.tick_sec ?? cur.tick_sec,
      event_kind: cur.event_kind,
      conditions: cur.conditions,
      instructions: p.instructions ?? cur.instructions,
      target: cur.target,
      cooldown_sec: p.tick_sec ?? cur.cooldown_sec,
      config_version: 2,
      execution_mode: "patrol",
      action_config: JSON.stringify(config),
      subsidiary_id: id,
    };
    const review = validateRuleDefinition(merged, deps.sources, inherit(id));
    if (!review.ok) return c.json({ error: "rule_review_failed", reason: review.reason }, 422);
    const updated = deps.rules.updateWithRevision(cur.id, cur.revision, {
      description: merged.description, tick_sec: merged.tick_sec, instructions: merged.instructions,
      cooldown_sec: merged.cooldown_sec, action_config: merged.action_config,
    });
    if (!updated) return c.json({ error: "revision_conflict" }, 409);
    deps.rules.setNextDue(cur.id, null);
    deps.versions?.record(updated, p.actor, "edited by subsidiary");
    deps.rules.log({ rule_id: cur.id, action: "add", actor: "human", detail: `edited by ${p.actor} (rev ${updated.revision})` });
    eventBus.emit({ type: "rule.changed", rule_id: cur.id, action: "toggle", ts: nowSec() });
    return c.json({ rule: deps.serializeRule(updated) });
  });

  app.post("/:id/patrol/rules/:ruleId/toggle", async (c) => {
    const id = c.req.param("id");
    const cur = ownedRule(id, c.req.param("ruleId"));
    if (!cur) return c.json({ error: "not_found" }, 404);
    const body = Toggle.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    if (body.data.enabled) {
      const review = validateRuleDefinition(cur, deps.sources, inherit(id));
      if (!review.ok) return c.json({ error: "rule_review_failed", reason: review.reason }, 422);
    }
    const updated = deps.rules.toggleWithRevision(cur.id, body.data.enabled);
    if (!body.data.enabled) deps.cancelInFlight?.(cur.id, "rule disabled", nowSec());
    else deps.rules.setNextDue(cur.id, null);
    if (updated) deps.versions?.record(updated, body.data.actor, body.data.enabled ? "enabled by subsidiary" : "disabled by subsidiary");
    deps.rules.log({ rule_id: cur.id, action: "add", actor: "human", detail: `toggle ${body.data.enabled ? "on" : "off"} by ${body.data.actor}` });
    eventBus.emit({ type: "rule.changed", rule_id: cur.id, action: "toggle", ts: nowSec() });
    return c.json({ rule: deps.serializeRule(deps.rules.find(cur.id)!) });
  });

  return app;
}
