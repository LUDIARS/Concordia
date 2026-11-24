/**
 * /v1/control/cards と /v1/control/sprints — 管制カードとスプリント状況の API
 * (loopback / 既存の Web SSO の範囲、CC-V5-INV-06。dots は指令ブリッジだけを使う)。
 *
 * - GET   /v1/control/cards?state=open|closed|all|discarded  カード一覧 (破棄は discarded でだけ。応答に discarded_count)
 * - PATCH /v1/control/cards/:id                    人間の捌き (優先度・担当者・催促・催促文・まとめ先) と人間依頼の「済み」
 * - GET   /v1/control/sprints                      スプリントの投影 (読み取り専用、Actio が正本)
 *
 * @implements spec/feature/control-cards.md — API
 */
import { Hono } from "hono";
import { z } from "zod";
import { CARD_PRIORITIES } from "../control-cards/card-domain.js";
import { REMINDER_TEXT_MAX_CHARS } from "../control-cards/card-triage-policy.js";
import type { ControlCardsService } from "../control-cards/service.js";
import type { Dialogue } from "../sprint-dialogues/domain.js";

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

const PatchSchema = z.object({
  priority: z.enum(CARD_PRIORITIES).optional(),
  assignee: nullableText(100),
  remind_at: z.string().datetime({ offset: true }).nullable().optional(),
  reminder_text: nullableText(REMINDER_TEXT_MAX_CHARS),
  group: nullableText(100),
  done: z.boolean().optional(),
  actor: z.string().trim().max(100).optional(),
}).strict();

export interface ControlCardsApiDeps {
  service: ControlCardsService;
  sprints?: () => Dialogue[];
}

const blankToNull = (value: string | null | undefined) => (value === undefined ? undefined : value?.trim() ? value.trim() : null);

export function controlCardsRouter(deps: ControlCardsApiDeps): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); });

  app.get("/cards", (c) => {
    const raw = c.req.query("state") ?? "open";
    // 破棄したカードは ?state=discarded でだけ返す (all は開閉だけ、CC-V5-INV-08)。
    const state = raw === "all" ? null : raw === "closed" ? "closed" : raw === "discarded" ? "discarded" : "open";
    return c.json({ cards: deps.service.list(state), discarded_count: deps.service.discardedCount() });
  });

  app.patch("/cards/:id", async (c) => {
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", detail: parsed.error.issues.map((issue) => issue.message) }, 400);
    const { priority, assignee, remind_at, reminder_text, group, done, actor } = parsed.data;
    const patch = {
      ...(priority ? { priority } : {}),
      ...(assignee !== undefined ? { assignee: blankToNull(assignee) } : {}),
      ...(remind_at !== undefined ? { remind_at: remind_at === null ? null : Date.parse(remind_at) } : {}),
      ...(reminder_text !== undefined ? { reminder_text: blankToNull(reminder_text) } : {}),
      ...(group !== undefined ? { card_group: blankToNull(group) } : {}),
    };
    if (!done && Object.keys(patch).length === 0) return c.json({ error: "invalid_request", detail: ["変更がありません"] }, 400);
    const id = c.req.param("id");
    const outcome = done ? deps.service.markDone(id, actor || "web") : deps.service.triage(id, patch, actor || "web");
    if (outcome.kind === "not_found") return c.json({ error: "not_found" }, 404);
    if (outcome.kind === "closed") return c.json({ error: "card_closed" }, 409);
    // 出所が正本のカードは既存の回答経路で解決する (CC-V5-INV-02)。
    if (outcome.kind === "not_owned") return c.json({ error: "resolve_at_source" }, 409);
    return c.json({ card: outcome.card });
  });

  app.get("/sprints", (c) => {
    const items = (deps.sprints?.() ?? []).map((dialogue) => ({
      dialogue_key: dialogue.projection.dialogueKey,
      team_id: dialogue.projection.teamId,
      sprint_id: dialogue.projection.sprintId,
      sprint_name: dialogue.projection.sprintName,
      phase: dialogue.projection.phase,
      held: dialogue.projection.held,
      closed: dialogue.projection.closed,
      task_count: dialogue.projection.taskIds.length,
      summary: dialogue.projection.summary.slice(0, 600),
      actio_path: dialogue.projection.actioPath,
      revision: dialogue.projection.revision,
    }));
    return c.json({ sprints: items });
  });

  return app;
}
