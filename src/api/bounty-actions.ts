/**
 * バグ報告への後続の操作 API (spec/feature/bug-bounty.md §5 §7)。 loopback 限定。
 *
 *   POST /v1/bounty/reports/:id/triage-result  仕分けの結果 (その報告の仕分けとして Cc が起動したセッションだけ)
 *   POST /v1/bounty/reports/:id/appeal         報告者の再審の申し出 (1 報告 1 回)
 *   POST /v1/bounty/reports/:id/close          権限者の手動クローズ (Discord `/bug close`、根拠必須)
 *
 * 人の名前での操作は Bot / Cocoiru の鍵が要る (CC-BOUNTY-INV-10)。 権限者 (社員名簿の管理職以上) かどうかは
 * ここで確かめ、状態の変更は use case が行う。 応答に原文を含めない。
 *
 * @implements SPEC-BOUNTY-TRIAGE
 * @implements SPEC-BOUNTY-APPEAL
 * @implements SPEC-BOUNTY-CLOSE
 */

import { Hono } from "hono";
import { z } from "zod";
import type { BountyCloseService } from "../bounty/close-service.js";
import { MAX_CLOSE_EVIDENCE_CHARS } from "../bounty/close-service.js";
import type { BountyJudgementService } from "../bounty/judgement-service.js";
import { MAX_APPEAL_REASON_CHARS } from "../bounty/judgement-service.js";
import type { BountyTriageService } from "../bounty/triage-service.js";
import {
  ActorShape,
  OPERATOR_UNAUTHORIZED,
  SNOWFLAKE,
  operatorAllowed,
  readActor,
  type BountyOperatorVerifier,
} from "./bounty-actor.js";
import { MAX_SUBSIDIARY_ID_LENGTH } from "../shared/subsidiary-id.js";

const TriageResultSchema = z.object({
  session_id: z.string().trim().min(1).max(200),
  /** 仕分けの結果。 中身の検証は use case (triage-result.ts) が行う。 */
  result: z.record(z.unknown()),
}).strict();

const AppealSchema = z.object({
  ...ActorShape,
  reason: z.string().max(MAX_APPEAL_REASON_CHARS),
}).strict();

const CloseSchema = z.object({
  platform: z.literal("discord"),
  actor: z.object({
    user_id: z.string().regex(SNOWFLAKE),
    subsidiary_id: z.string().trim().min(1).max(MAX_SUBSIDIARY_ID_LENGTH).nullable().optional(),
  }).strict(),
  evidence: z.string().max(MAX_CLOSE_EVIDENCE_CHARS),
}).strict();

const STATUS: Readonly<Record<string, 400 | 403 | 404 | 409 | 422>> = {
  report_not_found: 404,
  not_triage_session: 403,
  not_awaiting_triage: 409,
  invalid_result: 422,
  state_changed: 409,
  not_reporter: 403,
  not_appealable: 409,
  appeal_used: 409,
  reason_required: 400,
  not_closable: 409,
  evidence_required: 400,
};

export interface BountyActionsApiDeps {
  triage: BountyTriageService;
  judgement: BountyJudgementService;
  close: BountyCloseService;
  verifyOperator?: BountyOperatorVerifier;
  /** 本社の社員名簿で管理職以上か。 子会社 guild の操作者は権限者として扱わない。 */
  isAuthority(platform: "discord", userId: string): boolean;
}

export function bountyActionsRouter(deps: BountyActionsApiDeps): Hono {
  const app = new Hono();
  const fail = (error: string) => ({ error });
  const status = (error: string) => STATUS[error] ?? 400;

  app.post("/reports/:id/triage-result", async (c) => {
    const parsed = TriageResultSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_triage_result" }, 400);
    const result = await deps.triage.acceptResult({
      sessionId: parsed.data.session_id,
      reportId: c.req.param("id"),
      raw: parsed.data.result,
    });
    if (!result.ok) return c.json({ error: result.error, ...(result.errors ? { errors: result.errors } : {}) }, status(result.error));
    return c.json({ ok: true, status: result.status });
  });

  app.post("/reports/:id/appeal", async (c) => {
    const parsed = AppealSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_appeal" }, 400);
    const actor = readActor(parsed.data);
    if (!actor) return c.json({ error: "invalid_actor" }, 400);
    if (!operatorAllowed(actor, (name) => c.req.header(name), deps.verifyOperator)) return c.json(OPERATOR_UNAUTHORIZED, 403);
    const result = await deps.judgement.appeal({
      reportId: c.req.param("id"),
      actor: actor.kind === "session"
        ? { kind: "session", sessionId: actor.sessionId }
        : { kind: "person", key: { subsidiary_id: actor.companyId, platform: actor.platform, platform_user_id: actor.platformUserId } },
      reason: parsed.data.reason,
    });
    if (!result.ok) return c.json(fail(result.error), status(result.error));
    return c.json({ ok: true });
  });

  app.post("/reports/:id/close", async (c) => {
    const parsed = CloseSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_close" }, 400);
    if (!deps.verifyOperator?.("discord", c.req.header("x-concordia-bounty-operator") ?? null)) {
      return c.json(OPERATOR_UNAUTHORIZED, 403);
    }
    // 権限者は本社の管理職以上。 子会社 guild の利用者は閉じられない。
    if ((parsed.data.actor.subsidiary_id ?? null) !== null || !deps.isAuthority("discord", parsed.data.actor.user_id)) {
      return c.json({ error: "not_authority" }, 403);
    }
    const result = await deps.close.manualClose({
      reportId: c.req.param("id"),
      actor: `discord:${parsed.data.actor.user_id}`,
      evidence: parsed.data.evidence,
    });
    if (!result.ok) return c.json(fail(result.error), status(result.error));
    return c.json({ ok: true });
  });

  return app;
}
