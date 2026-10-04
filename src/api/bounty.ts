/**
 * バグ報告の受付 API (spec/feature/bug-bounty.md §3 §4)。 loopback 限定。
 *
 *   POST /v1/bounty/reports                  報告を受け付ける (セッション / Discord Bot / Cocoiru)
 *   POST /v1/bounty/reports/:id/withdraw     採用前の報告を本人が取り下げる
 *   POST /v1/bounty/reports/:id/amend        情報不足の報告へ本人が追記する
 *   POST /v1/bounty/reporters/public-name    公開名を変える (本人だけ)
 *
 * 報告を出せるのは、 有効な `session_id` を持つセッションか、 Bot / Cocoiru が渡す操作者 (`platform` + `actor`)。
 * 操作者の本人確認は Discord の操作者を Bot が渡す形で、 相談の API (consultations.ts) と同じ信頼境界に乗る。
 * 入力の形だけをここで検証し、 権限 (会社の範囲) と保存は受付 use case が行う。 応答に原文を含めない。
 *
 * @implements SPEC-BOUNTY-INTAKE
 * @implements SPEC-BOUNTY-REPORTER
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  MAX_BOUNTY_CLIENT_KEY_CHARS,
  MAX_BOUNTY_PROJECT_CODE_CHARS,
  MAX_BOUNTY_TEXT_CHARS,
} from "../bounty/intake.js";
import type { BountyActor, BountyIntakeError, BountyIntakeService, BountyReceipt } from "../bounty/intake-service.js";
import { MAX_SUBSIDIARY_ID_LENGTH } from "../shared/subsidiary-id.js";

const SNOWFLAKE = /^\d{5,32}$/;

const ActorShape = {
  /** セッション自身の報告。 */
  session_id: z.string().trim().min(1).max(200).optional(),
  /** Bot / Cocoiru が渡す受付口。 セッションは省略できる。 */
  platform: z.enum(["discord", "session", "cocoiru"]).optional(),
  /** Bot / Cocoiru が渡す操作者。 */
  actor: z.object({
    user_id: z.string().trim().min(1).max(200),
    subsidiary_id: z.string().trim().min(1).max(MAX_SUBSIDIARY_ID_LENGTH).nullable().optional(),
  }).strict().optional(),
};

const ReportSchema = z.object({
  ...ActorShape,
  client_key: z.string().trim().min(1).max(MAX_BOUNTY_CLIENT_KEY_CHARS).optional(),
  project: z.string().trim().max(MAX_BOUNTY_PROJECT_CODE_CHARS).nullable().optional(),
  what_happened: z.string().max(MAX_BOUNTY_TEXT_CHARS).optional(),
  repro_steps: z.string().max(MAX_BOUNTY_TEXT_CHARS).optional(),
  public_name: z.string().max(200).nullable().optional(),
  reply_to: z.object({
    guild_id: z.string().regex(SNOWFLAKE).optional(),
    channel_id: z.string().regex(SNOWFLAKE).optional(),
    notify_ref: z.string().trim().min(1).max(200).optional(),
  }).strict().optional(),
}).strict();

const ChangeSchema = z.object(ActorShape).strict();

const AmendSchema = z.object({
  ...ActorShape,
  what_happened: z.string().max(MAX_BOUNTY_TEXT_CHARS).optional(),
  repro_steps: z.string().max(MAX_BOUNTY_TEXT_CHARS).optional(),
}).strict();

const PublicNameSchema = z.object({
  platform: z.enum(["discord", "cocoiru"]),
  actor: ActorShape.actor.unwrap(),
  public_name: z.string().max(200).nullable(),
}).strict();

const STATUS: Readonly<Record<BountyIntakeError, 400 | 403 | 404 | 409>> = {
  invalid_session: 403,
  unknown_company: 400,
  client_key_required: 400,
  text_too_long: 400,
  unknown_project: 400,
  project_outside_company_scope: 403,
  public_name_invalid: 400,
  report_not_found: 404,
  not_reporter: 403,
  already_decided: 409,
  not_awaiting_info: 409,
  amendment_empty: 400,
  state_changed: 409,
};

/** 400 / 403 の理由 (受付口が利用者へそのまま返せる文)。 */
const REASONS: Readonly<Partial<Record<BountyIntakeError, string>>> = {
  invalid_session: "有効なセッションからの報告ではありません。",
  unknown_company: "操作者の所属会社が登録にありません。",
  client_key_required: "この受付口は冪等キー (client_key) が必要です。",
  text_too_long: `本文は ${MAX_BOUNTY_TEXT_CHARS} 文字までです。`,
  unknown_project: "対象プロジェクトのコードが project registry にありません。分からない場合は project を空にしてください。",
  project_outside_company_scope: "この会社の関係プロジェクトではないため、対象にできません。",
  public_name_invalid: "公開名は 32 文字までで、@ や < > ` 、リンク、改行を含められません。",
};

export const BOUNTY_RECEIVED_MESSAGE = "受け付けました。仕分け結果はこの受付口へ返します。";
export const BOUNTY_NEEDS_INFO_MESSAGE = "受け付けましたが、何が起きたかが書かれていません。追記してください。";

export interface BountyApiDeps {
  intake: BountyIntakeService;
}

type ActorInput = { session_id?: string; platform?: "discord" | "session" | "cocoiru"; actor?: { user_id: string; subsidiary_id?: string | null } };

/**
 * 報告を出す主体を決める。 `session_id` があればセッション、 無ければ Bot / Cocoiru の操作者。
 * 両方ある・どちらも無い・Discord のユーザー id が snowflake でない入力は受けない。
 */
function readActor(input: ActorInput): BountyActor | null {
  if (input.session_id) {
    if (input.actor || (input.platform && input.platform !== "session")) return null;
    return { kind: "session", sessionId: input.session_id };
  }
  if (!input.actor || !input.platform || input.platform === "session") return null;
  if (input.platform === "discord" && !SNOWFLAKE.test(input.actor.user_id)) return null;
  return {
    kind: "operator",
    platform: input.platform,
    companyId: input.actor.subsidiary_id ?? null,
    platformUserId: input.actor.user_id,
  };
}

function receiptBody(receipt: BountyReceipt): Record<string, unknown> {
  return {
    report_id: receipt.id,
    status: receipt.status,
    project: receipt.project,
    missing: receipt.missing,
    reporter: receipt.reporter,
    has_recipient: receipt.has_recipient,
  };
}

export function bountyRouter(deps: BountyApiDeps): Hono {
  const app = new Hono();
  const refuse = (error: BountyIntakeError) => ({ error, ...(REASONS[error] ? { reason: REASONS[error] } : {}) });

  app.post("/reports", async (c) => {
    const parsed = ReportSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_report" }, 400);
    const actor = readActor(parsed.data);
    if (!actor) return c.json({ error: "invalid_actor" }, 400);
    const result = deps.intake.submit({
      actor,
      clientKey: parsed.data.client_key ?? null,
      project: parsed.data.project ?? null,
      whatHappened: parsed.data.what_happened ?? "",
      reproSteps: parsed.data.repro_steps ?? "",
      publicName: parsed.data.public_name,
      replyTo: parsed.data.reply_to,
    });
    if (!result.ok) return c.json(refuse(result.error), STATUS[result.error]);
    return c.json({
      ...receiptBody(result.receipt),
      created: result.created,
      message: result.receipt.missing.length > 0 ? BOUNTY_NEEDS_INFO_MESSAGE : BOUNTY_RECEIVED_MESSAGE,
    }, result.created ? 201 : 200);
  });

  app.post("/reports/:id/withdraw", async (c) => {
    const parsed = ChangeSchema.safeParse(await c.req.json().catch(() => null));
    const actor = parsed.success ? readActor(parsed.data) : null;
    if (!actor) return c.json({ error: "invalid_actor" }, 400);
    const result = deps.intake.withdraw({ reportId: c.req.param("id"), actor });
    if (!result.ok) return c.json(refuse(result.error), STATUS[result.error]);
    return c.json(receiptBody(result.receipt));
  });

  app.post("/reports/:id/amend", async (c) => {
    const parsed = AmendSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_amendment" }, 400);
    const actor = readActor(parsed.data);
    if (!actor) return c.json({ error: "invalid_actor" }, 400);
    const result = deps.intake.amend({
      reportId: c.req.param("id"),
      actor,
      whatHappened: parsed.data.what_happened ?? "",
      reproSteps: parsed.data.repro_steps ?? "",
    });
    if (!result.ok) return c.json(refuse(result.error), STATUS[result.error]);
    return c.json(receiptBody(result.receipt));
  });

  app.post("/reporters/public-name", async (c) => {
    const parsed = PublicNameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_public_name_request" }, 400);
    if (parsed.data.platform === "discord" && !SNOWFLAKE.test(parsed.data.actor.user_id)) {
      return c.json({ error: "invalid_actor" }, 400);
    }
    const result = deps.intake.setPublicName({
      companyId: parsed.data.actor.subsidiary_id ?? null,
      platform: parsed.data.platform,
      platformUserId: parsed.data.actor.user_id,
      publicName: parsed.data.public_name,
    });
    if (!result.ok) return c.json(refuse(result.error), STATUS[result.error]);
    return c.json({ public_name: result.publicName, display: result.display });
  });

  return app;
}
