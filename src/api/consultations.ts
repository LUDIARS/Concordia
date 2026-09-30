/**
 * プライベート相談の公開候補 API (spec/feature/tech-consultation.md §5)。 loopback 限定の管理 API。
 *
 *   POST /v1/consultations/proposals                       セッションが公開候補を出す
 *   POST /v1/consultations/publications/:id/publish        本人が公開する (edited_summary で直せる)
 *   POST /v1/consultations/publications/:id/decline        本人が公開しない
 *   POST /v1/consultations/publications/:id/withdraw       権限者が取り下げる
 *
 * 判断の本人確認 (actor_user_id) は Discord の操作者を Bot が渡す。 Tabula の接続先とトークンは
 * Cc 本体だけが持つ (Bot へ渡さない) ので、 公開の実行はこの API を通す。
 *
 * @implements SPEC-CONSULT-PUBLISH
 * @implements SPEC-CONSULT-TABULA
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { ConcordiaEvent } from "../events.js";
import type { PublicationError, PublicationService } from "../consultation/publication-service.js";

const ProposalSchema = z.object({
  session_id: z.string().trim().min(1).max(200),
  title: z.string(),
  summary: z.string(),
}).strict();

const DecisionSchema = z.object({
  actor_user_id: z.string().trim().regex(/^\d{5,32}$/),
  edited_summary: z.string().max(20_000).optional(),
}).strict();

const STATUS: Readonly<Record<PublicationError, 400 | 403 | 404 | 409 | 502 | 503>> = {
  consultation_not_found: 404,
  consultation_not_open: 409,
  publication_not_found: 404,
  not_proposed: 409,
  not_requester: 403,
  not_approver: 403,
  invalid_proposal: 400,
  tabula_not_configured: 503,
  tabula_failed: 502,
};

export interface ConsultationsApiDeps {
  publications: PublicationService;
  emit(event: ConcordiaEvent): void;
  now?: () => number;
}

export function consultationsRouter(deps: ConsultationsApiDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  app.post("/proposals", async (c) => {
    const parsed = ProposalSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_proposal" }, 400);
    const result = deps.publications.propose({
      sessionId: parsed.data.session_id,
      title: parsed.data.title,
      summary: parsed.data.summary,
    });
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    const channelId = result.consultation.channel_id;
    if (channelId) {
      deps.emit({
        type: "consultation.proposed",
        event_id: randomUUID(),
        consultation_id: result.consultation.id,
        publication_id: result.publication.id,
        channel_id: channelId,
        tabula_ready: result.tabulaReady,
        ts: Math.floor(now() / 1000),
      });
    }
    return c.json({ publication_id: result.publication.id, tabula_ready: result.tabulaReady }, 201);
  });

  app.post("/publications/:id/:action{publish|decline|withdraw}", async (c) => {
    const parsed = DecisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_decision" }, 400);
    const id = c.req.param("id");
    const actor = parsed.data.actor_user_id;
    const action = c.req.param("action");
    const result = action === "publish"
      ? await deps.publications.publish({ publicationId: id, actorUserId: actor, editedSummary: parsed.data.edited_summary })
      : action === "decline"
        ? deps.publications.decline(id, actor)
        : deps.publications.withdraw(id, actor);
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    return c.json({ publication: result.publication });
  });

  return app;
}
