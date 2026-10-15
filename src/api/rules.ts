/**
 * /v1/rules API.
 *
 * 旧 rule (config_version=1, legacy-observe) の CRUD を保ったまま、 巡回チャット rule
 * (config_version=2, patrol) を同じ経路で扱う (spec/feature/patrol-chat.md §5 §9)。
 * - PUT / PATCH / toggle-enable / rollback は更新後の全体を同じ validator で検証する
 * - 版付き更新: 巡回 rule の PATCH は expected_revision 必須、 不一致は 409
 * - assist は draft を返すだけで保存・有効化しない
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RuleRow, RulesRepo, TriggerType } from "../db/rules-repo.js";
import type { RuleRunsRepo } from "../db/rule-runs-repo.js";
import type { RuleVersionsRepo } from "../db/rule-versions-repo.js";
import { eventBus } from "../events.js";
import { runClaude, extractJson } from "../rules/claude-runner.js";
import { KNOWN_EVENT_KINDS } from "../rules/review.js";
import { parseActionConfig, type SourceLookup, type SubsidiaryPatrolDefaults } from "../rules/patrol-config.js";
import { validateRuleDefinition, type RuleDefinition } from "../rules/rule-validation.js";
import { registerPatrolRoutes, type PatrolApiDeps } from "./rules-patrol.js";

function nowSec(): number { return Math.floor(Date.now() / 1000); }

const RuleInput = z.object({
  id: z.string().min(1).max(64),
  description: z.string().nullable().optional(),
  trigger_type: z.enum(["tick", "event"]),
  tick_sec: z.number().int().min(5).max(86400).nullable().optional(),
  event_kind: z.string().nullable().optional(),
  conditions: z.array(z.unknown()).optional(),
  instructions: z.string().min(1).max(4000),
  target: z.string().nullable().optional(),
  cooldown_sec: z.number().int().min(0).max(86400).optional(),
  /** 提案直後 enabled にせず disabled で保存し、 後で toggle で enable する review 経路.
   *  省略時は true (即時有効) ── 既存 API クライアント互換のため. 巡回 rule は省略時 false. */
  enabled: z.boolean().optional(),
  /** 2 = 巡回チャット rule。 省略時 1 (旧 rule)。 */
  config_version: z.union([z.literal(1), z.literal(2)]).optional(),
  action_config: z.record(z.unknown()).nullable().optional(),
  /** 持ち主の子会社 (省略・null = 本社)。 */
  subsidiary_id: z.string().min(1).max(64).nullable().optional(),
});

const PatchSchema = z.object({
  subsidiary_id: z.string().min(1).max(64).nullable().optional(),
  expected_revision: z.number().int().min(1).optional(),
  description: z.string().nullable().optional(),
  trigger_type: z.enum(["tick", "event"]).optional(),
  tick_sec: z.number().int().min(5).max(86400).nullable().optional(),
  event_kind: z.string().nullable().optional(),
  conditions: z.array(z.unknown()).optional(),
  instructions: z.string().min(1).max(4000).optional(),
  target: z.string().nullable().optional(),
  cooldown_sec: z.number().int().min(0).max(86400).optional(),
  config_version: z.union([z.literal(1), z.literal(2)]).optional(),
  action_config: z.record(z.unknown()).nullable().optional(),
});

export interface RulesApiDeps {
  rules: RulesRepo;
  /** 版履歴。 未配線なら版は残さない (旧構成互換)。 */
  versions?: RuleVersionsRepo;
  /** 巡回チャットの台帳と素材元。 未配線なら巡回 rule は作成・有効化できない。 */
  patrol?: PatrolApiDeps;
  /** rule の持ち主 (子会社)。 未配線なら子会社への紐付けは受け付けない。 */
  owners?: RuleOwnersLookup;
}

/** 子会社の存在確認と巡回の既定値 (spec/plan/2026-10-15-patrol-subsidiary-rules-design.md)。 */
export interface RuleOwnersLookup {
  exists(subsidiaryId: string): boolean;
  defaults(subsidiaryId: string): SubsidiaryPatrolDefaults | null;
}

const NO_SOURCES: SourceLookup = { has: () => false, describe: () => null };

export function rulesRouter(deps: RulesApiDeps): Hono {
  const app = new Hono();
  const sources: SourceLookup = deps.patrol?.sources ?? NO_SOURCES;
  const recordVersion = (rule: RuleRow, note: string) => deps.versions?.record(rule, "human", note);
  const inheritFor = (subsidiaryId: string | null | undefined) =>
    subsidiaryId ? deps.owners?.defaults(subsidiaryId) ?? null : null;
  const serializeRule = (r: RuleRow) => serialize(r, deps.patrol?.runs ?? null, sources, inheritFor(r.subsidiary_id));
  /** 持ち主の指定が妥当か。 不正なら理由。 */
  const ownerError = (subsidiaryId: string | null | undefined): string | null => {
    if (!subsidiaryId) return null;
    if (!deps.owners) return "subsidiary ownership is unavailable";
    return deps.owners.exists(subsidiaryId) ? null : `unknown subsidiary: ${subsidiaryId}`;
  };

  // 巡回の追加 route (/sources /preview /runs /service-events /:id/versions /:id/rollback) を先に登録する。
  if (deps.patrol) {
    registerPatrolRoutes(app, { ...deps.patrol, rules: deps.rules, versions: deps.versions ?? null, serializeRule, inheritFor });
  }

  // ?subsidiary_id=<id> で子会社、 ?head_office=1 で本社、 未指定で全社。
  app.get("/", (c) => {
    const subsidiaryId = c.req.query("subsidiary_id");
    const headOffice = c.req.query("head_office") === "1";
    if (subsidiaryId && headOffice) return c.json({ error: "subsidiary_id and head_office are exclusive" }, 400);
    const filter = subsidiaryId ? { subsidiary_id: subsidiaryId } : headOffice ? { subsidiary_id: null } : {};
    return c.json({ rules: deps.rules.list(filter).map(serializeRule) });
  });

  app.put("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RuleInput.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const r = parsed.data;
    if (deps.rules.find(r.id)) return c.json({ error: "id already exists; use PATCH /:id to update" }, 409);
    const version = r.config_version ?? 1;
    if (version === 2 && !deps.patrol) return c.json({ error: "patrol_unavailable" }, 503);
    const def: RuleDefinition = {
      id: r.id,
      description: r.description ?? null,
      trigger_type: r.trigger_type as TriggerType,
      tick_sec: r.tick_sec ?? null,
      event_kind: r.event_kind ?? null,
      conditions: JSON.stringify(r.conditions ?? []),
      instructions: r.instructions,
      target: r.target ?? null,
      cooldown_sec: r.cooldown_sec ?? 60,
      config_version: version,
      execution_mode: version === 2 ? "patrol" : "legacy-observe",
      action_config: version === 2 ? JSON.stringify(r.action_config ?? {}) : null,
      subsidiary_id: r.subsidiary_id ?? null,
    };
    const owner = ownerError(def.subsidiary_id);
    if (owner) return c.json({ error: "invalid_subsidiary", reason: owner }, 400);
    // 発火前の決定的レビュー (LLM 不使用). 落ちれば理由付きで拒否.
    const review = validateRuleDefinition(def, sources, inheritFor(def.subsidiary_id));
    if (!review.ok) {
      deps.rules.log({ rule_id: r.id, action: "error", actor: "human", detail: `rejected by review: ${review.reason}` });
      return c.json({ error: "rule_review_failed", reason: review.reason }, 422);
    }
    // 巡回 rule は投稿副作用を持つので、 明示しない限り無効で保存する (preview で確かめてから有効化)。
    const enabled = r.enabled ?? version === 1;
    const inserted = deps.rules.insert({
      id: def.id,
      description: def.description,
      trigger_type: def.trigger_type,
      tick_sec: def.tick_sec,
      event_kind: def.event_kind,
      conditions: def.conditions,
      instructions: def.instructions,
      target: def.target,
      cooldown_sec: def.cooldown_sec,
      added_by: "human",
      enabled,
      config_version: def.config_version,
      execution_mode: def.execution_mode,
      action_config: def.action_config,
      subsidiary_id: def.subsidiary_id ?? null,
    });
    recordVersion(inserted, "created");
    deps.rules.log({
      rule_id: r.id,
      action: "add",
      actor: "human",
      detail: `${enabled ? "added via API (enabled)" : "proposed via API (disabled)"} v${version}`,
    });
    eventBus.emit({ type: "rule.changed", rule_id: r.id, action: "add", ts: nowSec() });
    return c.json({ rule: serializeRule(inserted) });
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body?.reason === "string" ? body.reason : null;
    const ok = deps.rules.remove(id, "human", reason);
    if (!ok) return c.json({ error: "not_found" }, 404);
    deps.patrol?.runs.cancelInFlight(id, "rule removed", nowSec());
    deps.rules.log({ rule_id: id, action: "remove", actor: "human", detail: reason ?? undefined });
    eventBus.emit({ type: "rule.changed", rule_id: id, action: "remove", ts: nowSec() });
    return c.json({ ok: true });
  });

  // PATCH /v1/rules/:id  — 更新後の全体を検証し、 版を進めて保存する
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const cur = deps.rules.find(id);
    if (!cur || cur.removed_at) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const p = parsed.data;
    const nextVersion = p.config_version ?? cur.config_version;
    if ((cur.config_version === 2 || nextVersion === 2) && p.expected_revision === undefined) {
      return c.json({ error: "expected_revision_required", revision: cur.revision }, 428);
    }
    if (p.expected_revision !== undefined && p.expected_revision !== cur.revision) {
      return c.json({ error: "revision_conflict", revision: cur.revision }, 409);
    }
    if (nextVersion === 2 && !deps.patrol) return c.json({ error: "patrol_unavailable" }, 503);
    const merged: RuleDefinition = {
      id,
      description: p.description !== undefined ? p.description : cur.description,
      trigger_type: (p.trigger_type ?? cur.trigger_type) as TriggerType,
      tick_sec: p.tick_sec !== undefined ? p.tick_sec : cur.tick_sec,
      event_kind: p.event_kind !== undefined ? p.event_kind : cur.event_kind,
      conditions: p.conditions ? JSON.stringify(p.conditions) : cur.conditions,
      instructions: p.instructions ?? cur.instructions,
      target: p.target !== undefined ? p.target : cur.target,
      cooldown_sec: p.cooldown_sec ?? cur.cooldown_sec,
      config_version: nextVersion,
      execution_mode: nextVersion === 2 ? "patrol" : "legacy-observe",
      action_config: nextVersion === 2
        ? (p.action_config !== undefined ? JSON.stringify(p.action_config ?? {}) : cur.action_config)
        : null,
      subsidiary_id: p.subsidiary_id !== undefined ? p.subsidiary_id : cur.subsidiary_id,
    };
    const owner = ownerError(merged.subsidiary_id);
    if (owner) return c.json({ error: "invalid_subsidiary", reason: owner }, 400);
    const review = validateRuleDefinition(merged, sources, inheritFor(merged.subsidiary_id));
    if (!review.ok) {
      deps.rules.log({ rule_id: id, action: "error", actor: "human", detail: `edit rejected by review: ${review.reason}` });
      return c.json({ error: "rule_review_failed", reason: review.reason }, 422);
    }
    const updated = deps.rules.updateWithRevision(id, cur.revision, {
      description: merged.description,
      trigger_type: merged.trigger_type,
      tick_sec: merged.tick_sec,
      event_kind: merged.event_kind,
      conditions: merged.conditions,
      instructions: merged.instructions,
      target: merged.target,
      cooldown_sec: merged.cooldown_sec,
      config_version: merged.config_version,
      execution_mode: merged.execution_mode,
      action_config: merged.action_config,
      subsidiary_id: merged.subsidiary_id ?? null,
    });
    if (!updated) return c.json({ error: "revision_conflict", revision: deps.rules.find(id)?.revision ?? null }, 409);
    // 間隔が変わった可能性があるので次回期日は作り直させる。
    deps.rules.setNextDue(id, null);
    recordVersion(updated, "edited");
    deps.rules.log({ rule_id: id, action: "add", actor: "human", detail: `edited via API (rev ${updated.revision})` });
    eventBus.emit({ type: "rule.changed", rule_id: id, action: "toggle", ts: nowSec() });
    return c.json({ rule: serializeRule(updated) });
  });

  // POST /v1/rules/assist  — partial rule を AI に補完してもらう (insert はしない、結果のみ返す)
  const AssistSchema = z.object({
    partial: z.record(z.unknown()),
  });
  app.post("/assist", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AssistSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const partial = parsed.data.partial;

    const prompt = [
      "あなたは Concordia の **rule 補完アシスタント** です. ユーザが書きかけの rule 設定を受け取り、 不足項目を補ってください.",
      "",
      "## rule schema (Concordia rule engine が解釈する形)",
      `- id: kebab-case 一意 (空なら 内容から推測して命名)`,
      `- description: 1 行で目的説明`,
      `- trigger_type: "tick" | "event"`,
      `- tick_sec: trigger_type=tick の場合のみ (5〜86400 秒)`,
      `- event_kind: trigger_type=event の場合の event 名. 取りうる値: ${KNOWN_EVENT_KINDS.join(", ")}. "*" で全 event.`,
      `- conditions: condition 配列 (例: [{"type":"any_active_session"}])`,
      `- instructions: claude CLI に渡す指示文 (空ならユーザの意図から推測して書く)`,
      `- cooldown_sec: 連続発火抑制 (60〜600 推奨)`,
      "",
      "## 補完ルール",
      "- ユーザが既に埋めた値は **絶対に上書きしない** (尊重)",
      "- trigger_type が tick で tick_sec 未指定なら instructions の文脈から妥当な秒数を入れる (短くて 60、長くて 3600)",
      "- trigger_type が event で event_kind 未指定なら instructions の文脈から最適なものを KNOWN_EVENT_KINDS から選ぶ. 確信が無ければ '*'",
      "- description が空ならユーザ意図を 1 行に圧縮した日本語",
      "- id が空なら内容から kebab-case で 1 つ作る",
      "- cooldown_sec 未指定なら 300",
      "- 出力は JSON 1 オブジェクトのみ. 余計な前置き / code fence なし.",
      "",
      "## ユーザの partial",
      JSON.stringify(partial, null, 2),
      "",
      '## 出力スキーマ (rule 全フィールドを返す. `enabled` は含めない)',
      '{"id":"","description":"","trigger_type":"","tick_sec":null,"event_kind":null,"conditions":[],"instructions":"","cooldown_sec":300}',
    ].join("\n");

    // rule 補完は人手のオーサリング補助 (低頻度). Haiku で十分. 結果は draft で、 保存・有効化しない.
    const r = await runClaude(prompt, { model: "haiku" });
    if (!r.ok) return c.json({ error: `claude failed: ${r.stderr.slice(0, 200)}` }, 502);
    const json = extractJson(r.stdout);
    if (!json || typeof json !== "object") return c.json({ error: "unparsable", stdout_preview: r.stdout.slice(0, 200) }, 502);
    return c.json({ rule: json });
  });

  // GET /v1/rules/event-kinds  — UI dropdown 用
  app.get("/event-kinds", (c) => {
    return c.json({ event_kinds: KNOWN_EVENT_KINDS });
  });

  app.post("/:id/toggle", async (c) => {
    const id = c.req.param("id");
    const cur = deps.rules.find(id);
    if (!cur || cur.removed_at) return c.json({ error: "not_found" }, 404);
    const next = !cur.enabled;
    if (next) {
      // 有効化の前に現在の設定を検証し直す (素材元の登録状況も変わり得る)。
      if (cur.config_version === 2 && !deps.patrol) return c.json({ error: "patrol_unavailable" }, 503);
      const review = validateRuleDefinition(cur, sources, inheritFor(cur.subsidiary_id));
      if (!review.ok) return c.json({ error: "rule_review_failed", reason: review.reason }, 422);
    }
    const updated = cur.config_version === 2 ? deps.rules.toggleWithRevision(id, next) : (deps.rules.toggle(id, next), deps.rules.find(id));
    if (!next) deps.patrol?.runs.cancelInFlight(id, "rule disabled", nowSec());
    if (next) deps.rules.setNextDue(id, null);
    if (updated && cur.config_version === 2) recordVersion(updated, next ? "enabled" : "disabled");
    deps.rules.log({
      rule_id: id,
      action: "add",
      actor: "human",
      detail: `toggle: ${next ? "enabled" : "disabled"}`,
    });
    eventBus.emit({ type: "rule.changed", rule_id: id, action: "toggle", ts: nowSec() });
    return c.json({ rule: serializeRule(deps.rules.find(id)!) });
  });

  app.get("/log", (c) => {
    const raw = Number(c.req.query("limit") ?? "100");
    const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 200) : 100;
    return c.json({ logs: deps.rules.recentLogs(limit) });
  });

  return app;
}

/** rule の実行可否と不足理由。 旧 rule は legacy-observe (投稿しない) と明示する。 */
export function readinessOf(
  r: RuleRow,
  sources: SourceLookup,
  inherit?: SubsidiaryPatrolDefaults | null,
): { runnable: boolean; reason: string } {
  if (r.removed_at) return { runnable: false, reason: "removed" };
  if (r.execution_mode !== "patrol") return { runnable: false, reason: "legacy-observe (投稿しない旧 rule)" };
  const review = validateRuleDefinition(r, sources, inherit);
  if (!review.ok) return { runnable: false, reason: review.reason };
  if (!r.enabled) return { runnable: false, reason: "disabled" };
  if (inherit?.paused) return { runnable: false, reason: "owner subsidiary paused" };
  return { runnable: true, reason: "ready" };
}

/**
 * action_config は保存された形 (引き継ぐ項目は書かれていなければ無い)、 effective_config は
 * 持ち主の子会社 → 全体の既定値で埋めた実行時の値。 編集は action_config を元に行う。
 */
export function serialize(
  r: RuleRow,
  runs: Pick<RuleRunsRepo, "list"> | null,
  sources: SourceLookup,
  inherit?: SubsidiaryPatrolDefaults | null,
) {
  const config = r.config_version === 2 ? parseActionConfig(r.action_config, inherit) : null;
  const last = runs ? runs.list({ rule_id: r.id, limit: 1 }).runs[0] ?? null : null;
  return {
    id: r.id,
    description: r.description,
    trigger_type: r.trigger_type,
    tick_sec: r.tick_sec,
    event_kind: r.event_kind,
    conditions: safeParse(r.conditions),
    instructions: r.instructions,
    target: r.target,
    cooldown_sec: r.cooldown_sec,
    last_fired_at: r.last_fired_at,
    enabled: !!r.enabled,
    added_at: r.added_at,
    added_by: r.added_by,
    removed_at: r.removed_at,
    removed_by: r.removed_by,
    removed_reason: r.removed_reason,
    config_version: r.config_version,
    revision: r.revision,
    execution_mode: r.execution_mode,
    action_config: config?.ok ? config.input : r.action_config ? safeParse(r.action_config) : null,
    effective_config: config?.ok ? config.config : null,
    subsidiary_id: r.subsidiary_id ?? null,
    next_due_at: r.next_due_at,
    last_attempt_at: r.last_attempt_at,
    last_posted_at: r.last_posted_at,
    readiness: readinessOf(r, sources, inherit),
    last_run: last ? { run_id: last.run_id, status: last.status, reason: last.reason, created_at: last.created_at } : null,
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
