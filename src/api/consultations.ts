/**
 * プライベート相談の公開候補 API (spec/feature/tech-consultation.md §5)。 loopback 限定の管理 API。
 *
 *   POST /v1/consultations/proposals                       セッションが公開候補を出す
 *   POST /v1/consultations/publications/:id/publish        本人が公開する (edited_summary で直せる)
 *   POST /v1/consultations/publications/:id/decline        本人が公開しない
 *   POST /v1/consultations/publications/:id/withdraw       権限者が取り下げる
 *   POST /v1/consultations/:id/share-proposal              閉じた相談の共有の問いを出す (§7、 Bot が判定後に呼ぶ)
 *   POST /v1/consultations/publications/:id/expire         共有の問いに 24 時間反応なし (§7)
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
import type { PrivateConsultationRow } from "../db/private-consultations-repo.js";

const ProposalSchema = z.object({
  session_id: z.string().trim().min(1).max(200),
  title: z.string(),
  summary: z.string(),
}).strict();

const ShareProposalSchema = z.object({
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
  consultation_not_closed: 409,
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
  /** 候補の判断カードを相談チャンネルにだけ出す (Bot が consultation.proposed を受けて投稿する)。 */
  const emitProposed = (result: { consultation: PrivateConsultationRow; publication: { id: string }; tabulaReady: boolean }): void => {
    const channelId = result.consultation.channel_id;
    if (!channelId) return;
    deps.emit({
      type: "consultation.proposed",
      event_id: randomUUID(),
      consultation_id: result.consultation.id,
      publication_id: result.publication.id,
      channel_id: channelId,
      tabula_ready: result.tabulaReady,
      ts: Math.floor(now() / 1000),
    });
  };

  app.post("/proposals", async (c) => {
    const parsed = ProposalSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_proposal" }, 400);
    const result = deps.publications.propose({
      sessionId: parsed.data.session_id,
      title: parsed.data.title,
      summary: parsed.data.summary,
    });
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    emitProposed(result);
    return c.json({ publication_id: result.publication.id, tabula_ready: result.tabulaReady }, 201);
  });

  app.post("/:id/share-proposal", async (c) => {
    const parsed = ShareProposalSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_proposal" }, 400);
    const result = deps.publications.proposeOnClose({
      consultationId: c.req.param("id"),
      title: parsed.data.title,
      summary: parsed.data.summary,
    });
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    emitProposed(result);
    return c.json({ publication_id: result.publication.id, tabula_ready: result.tabulaReady }, 201);
  });

  app.post("/publications/:id/expire", (c) => {
    const result = deps.publications.expire(c.req.param("id"));
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    return c.json({ publication: result.publication });
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
