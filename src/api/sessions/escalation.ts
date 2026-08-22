/**
 * エスカレーションモードの宣言・解除 API (spec/feature/escalation-mode.md §1).
 *
 * `reason` を必須にするのは、 後追いレビューの対象を記録だけから特定できるようにするため。
 * 理由の無いエスカレーションは、 事後には通常作業と区別が付かない。
 */

import type { Hono } from "hono";
import { z } from "zod";
import type { SessionsApiDeps } from "./deps.js";
import { endEscalation, startEscalation } from "../../control/escalation-mode.js";

const StartSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  actor: z.string().trim().min(1).max(200).optional(),
});

const ReleaseSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

export function registerEscalationRoutes(app: Hono, deps: SessionsApiDeps): void {
  app.post("/:id/escalation", async (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);

    const parsed = StartSchema.safeParse(await c.req.json().catch(() => null));
    // reason 無し / 空白のみは 400。 理由の無い記録は監査として成立しない。
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);

    const result = startEscalation(
      { sessions: deps.repo, escalations: deps.escalations, tasks: deps.tasks },
      {
        session_id: id,
        actor: parsed.data.actor ?? session.provider,
        reason: parsed.data.reason,
        source: "api",
      },
    );

    deps.repo.appendEvent({
      session_id: id,
      ts: result.event.started_at,
      kind: "escalation_started",
      payload: {
        reason: result.event.reason,
        actor: result.event.actor,
        stopped_session_ids: result.stopped_session_ids,
      },
    });

    return c.json({
      escalation: result.event,
      stopped_session_ids: result.stopped_session_ids,
    });
  });

  app.delete("/:id/escalation", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);

    // 解除は body なしを許す (note は任意)。 壊れた JSON だけ弾く。
    const raw = await c.req.json().catch(() => ({}));
    const parsed = ReleaseSchema.safeParse(raw ?? {});
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);

    const result = endEscalation(
      { sessions: deps.repo, escalations: deps.escalations, tasks: deps.tasks },
      { session_id: id, note: parsed.data.note ?? null },
    );

    deps.repo.appendEvent({
      session_id: id,
      ts: result.event?.ended_at ?? Math.floor(Date.now() / 1000),
      kind: "escalation_ended",
      payload: {
        note: parsed.data.note ?? null,
        withdrawn_claims: result.withdrawn_claims,
        had_open_event: result.event !== null,
      },
    });

    return c.json({
      escalation: result.event,
      withdrawn_claims: result.withdrawn_claims,
    });
  });

  app.get("/:id/escalation", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    return c.json({
      active: deps.escalations.isEscalated(id),
      open: deps.escalations.findOpen(id),
      history: deps.escalations.listBySession(id),
    });
  });
}
