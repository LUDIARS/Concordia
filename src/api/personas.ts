/**
 * /v1/personas API.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { PersonasRepo, PersonaRow } from "../db/personas-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ChatRepo } from "../db/chat-repo.js";
import type { ConcordiaConfig } from "../shared/config.js";
import { eventBus } from "../events.js";
import { collectSignals } from "../personas/signals.js";
import { generatePersonaDraft } from "../personas/generate.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("personas-api");

export interface PersonasApiDeps {
  personas: PersonasRepo;
  sessions: SessionsRepo;
  chat: ChatRepo;
  config: ConcordiaConfig;
}

function nowSec(): number { return Math.floor(Date.now() / 1000); }

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function serializePersona(p: PersonaRow) {
  return {
    id: p.id,
    name: p.name,
    display_name: p.display_name ?? "",
    description: p.description,
    traits: safeParseJson(p.traits),
    speech_style: p.speech_style,
    skill_template: p.skill_template,
    learned_notes: safeParseJson(p.learned_notes),
    generated: Boolean(p.generated),
    origin_session_id: p.origin_session_id ?? null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export function personasRouter(deps: PersonasApiDeps): Hono {
  const app = new Hono();

  // GET /v1/personas — 一覧
  app.get("/", (c) => {
    const personas = deps.personas.list();
    const activeIds = deps.personas.listActivePersonaIds();
    return c.json({
      personas: personas.map((p) => ({
        ...serializePersona(p),
        is_active: activeIds.has(p.id),
      })),
    });
  });

  // GET /v1/personas/active — アクティブ assignment 一覧 (UI Member 表示用)
  app.get("/active", (c) => {
    const items = deps.personas.listActiveAssignments().map((a) => ({
      assignment_id: a.id,
      session_id: a.session_id,
      assigned_at: a.assigned_at,
      persona: serializePersona(a.persona),
    }));
    return c.json({ active: items });
  });

  // GET /v1/personas/:id — 詳細 + 直近 feedback + 直近 assignment
  app.get("/:id", (c) => {
    const id = c.req.param("id");
    const p = deps.personas.find(id);
    if (!p) return c.json({ error: "not_found" }, 404);
    const feedback = deps.personas.recentFeedback(id, 30).map((f) => ({
      ...f,
      detail: f.detail ? safeParseJson(f.detail) : null,
    }));
    const assignments = deps.personas.recentAssignmentsByPersona(id, 30);
    return c.json({
      persona: serializePersona(p),
      feedback,
      assignments,
    });
  });

  // PATCH /v1/personas/:id — 手動編集 (description / speech_style / traits / skill_template / display_name)
  const PatchSchema = z.object({
    name: z.string().min(1).max(64).optional(),
    display_name: z.string().max(64).optional(),
    description: z.string().max(500).optional(),
    traits: z.array(z.string().max(80)).max(20).optional(),
    speech_style: z.string().max(2000).optional(),
    skill_template: z.string().max(8000).optional(),
  });
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const cur = deps.personas.find(id);
    if (!cur) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const p = parsed.data;
    deps.personas.update(id, {
      name: p.name,
      display_name: p.display_name,
      description: p.description,
      traits: p.traits ? JSON.stringify(p.traits) : undefined,
      speech_style: p.speech_style,
      skill_template: p.skill_template,
    });
    deps.personas.appendFeedback({
      persona_id: id,
      session_id: null,
      kind: "manual",
      delta: "human edited persona via API",
      detail: { fields: Object.keys(p) },
    });
    return c.json({ persona: serializePersona(deps.personas.find(id)!) });
  });

  // POST /v1/personas/:id/feedback — 手動 feedback 追加
  const FeedbackSchema = z.object({
    delta: z.string().min(1).max(200),
    session_id: z.string().nullable().optional(),
    kind: z.enum(["manual", "chat-update", "system"]).optional(),
    append_to_learned: z.boolean().optional(),
  });
  app.post("/:id/feedback", async (c) => {
    const id = c.req.param("id");
    const cur = deps.personas.find(id);
    if (!cur) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = FeedbackSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const fb = deps.personas.appendFeedback({
      persona_id: id,
      session_id: parsed.data.session_id ?? null,
      kind: parsed.data.kind ?? "manual",
      delta: parsed.data.delta,
    });
    if (parsed.data.append_to_learned !== false) {
      deps.personas.appendLearnedNote(id, parsed.data.delta);
    }
    eventBus.emit({
      type: "persona.feedback",
      persona_id: id,
      session_id: parsed.data.session_id ?? null,
      kind: parsed.data.kind ?? "manual",
      ts: nowSec(),
    });
    return c.json({ feedback: { ...fb, detail: fb.detail ? safeParseJson(fb.detail) : null } });
  });

  // GET /v1/personas/feedback/recent — 全 persona 横断 feedback ログ (UI 用)
  app.get("/feedback/recent", (c) => {
    const limit = Math.min(200, Number(c.req.query("limit") ?? "100"));
    const rows = deps.personas.recentFeedbackAll(limit).map((f) => ({
      ...f,
      detail: f.detail ? safeParseJson(f.detail) : null,
    }));
    return c.json({ feedback: rows });
  });

  // POST /v1/personas/generate — 投稿者 (セッション) の活動シグナルから人格を動的生成し、
  // そのセッションに排他 assign する. 既存 (seed / 別生成) assignment があれば切替える.
  // 「後から API で」 人格を作り直す導線 (同一セッションの再呼び出しは生成人格行を更新するだけ).
  const GenerateSchema = z.object({
    session_id: z.string().min(1).max(128),
  });
  app.post("/generate", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = GenerateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const session = deps.sessions.findSession(parsed.data.session_id);
    if (!session) return c.json({ error: "session_not_found" }, 404);

    const events = deps.sessions.recentEvents(session.id, 200);
    const signals = collectSignals({ chat: deps.chat }, session, events);
    const draft = await generatePersonaDraft(signals);
    const { persona, reused } = deps.personas.createGenerated(draft, session.id);

    // UI / statusline の一貫性のため session metadata にも反映 (sessions.ts の assign と同形).
    deps.sessions.mergeMetadata(session.id, {
      role_label: persona.name,
      persona_id: persona.id,
    });
    eventBus.emit({
      type: "persona.assigned",
      session_id: session.id,
      persona_id: persona.id,
      persona_name: persona.name,
      ts: nowSec(),
    });
    deps.personas.appendFeedback({
      persona_id: persona.id,
      session_id: session.id,
      kind: "system",
      delta: `投稿者シグナルから人格を${reused ? "再" : ""}生成 (role=${signals.role_label}, repo=${signals.repo_base})`,
      detail: { reused, signals_role: signals.role_label, repo: signals.repo_base },
    });
    log.info({ session_id: session.id, persona_id: persona.id, reused }, "generated persona assigned");

    return c.json({ persona: serializePersona(persona), reused, signals });
  });

  return app;
}
