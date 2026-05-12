/**
 * /v1/rules API.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RulesRepo, TriggerType } from "../db/rules-repo.js";
import { eventBus } from "../events.js";
import { runClaude, extractJson } from "../rules/claude-runner.js";

function nowSec(): number { return Math.floor(Date.now() / 1000); }

/** rule engine が認識する event_kind の一覧 (`*` で全 event). 編集 UI から見えるよう公開. */
const KNOWN_EVENT_KINDS = [
  "*",
  "session.started",
  "session.ended",
  "session.lost",
  "session.event",
  "chat.posted",
  "task.enqueued",
  "skill.snapshot",
  "report.generated",
  "rule.changed",
] as const;

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
   *  省略時は true (即時有効) ── 既存 API クライアント互換のため. */
  enabled: z.boolean().optional(),
});

export interface RulesApiDeps {
  rules: RulesRepo;
}

export function rulesRouter(deps: RulesApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json({
      rules: deps.rules.list().map(serialize),
    });
  });

  app.put("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RuleInput.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const r = parsed.data;
    const existing = deps.rules.find(r.id);
    if (existing) return c.json({ error: "id already exists; use POST /:id/toggle to update enabled" }, 409);
    const enabled = r.enabled !== false; // 省略時 true. 明示的に false ならレビュー待ち.
    const inserted = deps.rules.insert({
      id: r.id,
      description: r.description ?? null,
      trigger_type: r.trigger_type as TriggerType,
      tick_sec: r.tick_sec ?? null,
      event_kind: r.event_kind ?? null,
      conditions: JSON.stringify(r.conditions ?? []),
      instructions: r.instructions,
      target: r.target ?? null,
      cooldown_sec: r.cooldown_sec ?? 60,
      added_by: "human",
      enabled,
    });
    deps.rules.log({
      rule_id: r.id,
      action: "add",
      actor: "human",
      detail: enabled ? "added via API (enabled)" : "proposed via API (review-pending, disabled)",
    });
    eventBus.emit({ type: "rule.changed", rule_id: r.id, action: "add", ts: nowSec() });
    return c.json({ rule: serialize(inserted) });
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body?.reason === "string" ? body.reason : null;
    const ok = deps.rules.remove(id, "human", reason);
    if (!ok) return c.json({ error: "not_found" }, 404);
    deps.rules.log({ rule_id: id, action: "remove", actor: "human", detail: reason });
    eventBus.emit({ type: "rule.changed", rule_id: id, action: "remove", ts: nowSec() });
    return c.json({ ok: true });
  });

  // PATCH /v1/rules/:id  — instructions / event_kind / tick_sec etc を編集
  const PatchSchema = z.object({
    description: z.string().nullable().optional(),
    trigger_type: z.enum(["tick", "event"]).optional(),
    tick_sec: z.number().int().min(5).max(86400).nullable().optional(),
    event_kind: z.string().nullable().optional(),
    conditions: z.array(z.unknown()).optional(),
    instructions: z.string().min(1).max(4000).optional(),
    target: z.string().nullable().optional(),
    cooldown_sec: z.number().int().min(0).max(86400).optional(),
  });
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const cur = deps.rules.find(id);
    if (!cur) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const p = parsed.data;
    deps.rules.updateRule(id, {
      description: p.description,
      trigger_type: p.trigger_type as TriggerType | undefined,
      tick_sec: p.tick_sec,
      event_kind: p.event_kind,
      conditions: p.conditions ? JSON.stringify(p.conditions) : undefined,
      instructions: p.instructions,
      target: p.target,
      cooldown_sec: p.cooldown_sec,
    });
    deps.rules.log({ rule_id: id, action: "add", actor: "human", detail: "edited via API" });
    eventBus.emit({ type: "rule.changed", rule_id: id, action: "toggle", ts: nowSec() });
    return c.json({ rule: serialize(deps.rules.find(id)!) });
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

    const r = await runClaude(prompt);
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
    if (!cur) return c.json({ error: "not_found" }, 404);
    const next = !cur.enabled;
    deps.rules.toggle(id, next);
    deps.rules.log({
      rule_id: id,
      action: "add",
      actor: "human",
      detail: `toggle: ${next ? "enabled" : "disabled"}`,
    });
    eventBus.emit({ type: "rule.changed", rule_id: id, action: "toggle", ts: nowSec() });
    return c.json({ rule: serialize(deps.rules.find(id)!) });
  });

  app.get("/log", (c) => {
    const limit = Number(c.req.query("limit") ?? "100");
    return c.json({ logs: deps.rules.recentLogs(limit) });
  });

  return app;
}

function serialize(r: ReturnType<RulesRepo["list"]>[number]) {
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
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
