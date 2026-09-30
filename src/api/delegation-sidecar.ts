/**
 * /v1/delegation/sidecar — Astra With Sidecar の HTTP 境界。
 *
 * - POST /route                       振り分け判定 (親が作業の受付・範囲変更時に呼ぶ) と記録
 * - GET  /observation                 親子 run・判定・拒否の集計 (価格不明を 0 にしない)
 * - POST /conversations/ingress       chat 側 (別プロセス可) からの人間入力の受付
 * - POST /conversations/inputs/:id/delivery  ingress が inject した結果の記録
 * - GET  /conversations/:id           会話の担当・世代・入力状態・交代履歴 (本文は返さない)
 * - POST /handoffs/:id/package        旧担当による引継ぎの保存
 * - POST /handoffs/:id/advance        交代の照合を 1 回進める (reconciler と同じ処理)
 *
 * loopback 限定の Concordia と同じ信頼境界に乗る。 判断は純関数と use case に委ねる。
 *
 * @implements spec/feature/astra-with-sidecar.md
 */

import { Hono } from "hono";
import { z } from "zod";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import { decideSidecarRoute, type SidecarRouteClassifier } from "../delegation/sidecar/route-policy.js";
import type { SidecarRecordsRepo } from "../delegation/sidecar/records-repo.js";
import { summarizeSidecarObservation } from "../delegation/sidecar/observation.js";
import type { ConversationService } from "../control/conversation/service.js";
import type { ConversationRepo } from "../control/conversation/repo.js";

const RouteSchema = z.object({
  parent_session_id: z.string().trim().min(1).max(200),
  task_reference: z.string().trim().min(1).max(500).nullable().optional(),
  request_version: z.number().int().positive().nullable().optional(),
  input: z.object({
    kind: z.enum([
      "ui_tweak", "known_spec_branch", "list_or_text", "doc_extraction",
      "local_fix_with_repro", "cross_cutting_design", "root_cause_unknown", "other",
    ]),
    size: z.enum(["tiny", "small", "medium", "large"]),
    acceptanceDefined: z.boolean(),
    scopeDefined: z.boolean(),
    sensitive: z.boolean(),
    openQuestions: z.boolean(),
  }).strict(),
}).strict();

const IngressSchema = z.object({
  platform: z.enum(["discord"]),
  scope: z.string().max(120).default(""),
  guild_id: z.string().regex(/^\d{5,32}$/),
  thread_id: z.string().regex(/^\d{5,32}$/),
  message_id: z.string().regex(/^\d{5,32}$/),
  author_id: z.string().regex(/^\d{5,32}$/),
  author_label: z.string().max(200).nullable().optional(),
  text: z.string().max(100_000),
  bound_session_id: z.string().trim().min(1).max(200),
  can_control_session: z.boolean(),
}).strict();

const DeliverySchema = z.object({
  outcome: z.enum(["delivered", "uncertain", "failed"]),
  error: z.string().max(1000).nullable().optional(),
}).strict();

const PackageSchema = z.object({
  session_id: z.string().trim().min(1).max(200),
  package: z.record(z.unknown()),
}).strict();

export interface DelegationSidecarApiDeps {
  records: SidecarRecordsRepo;
  classifier?: SidecarRouteClassifier | null;
  listRunsByParentSession: (sessionId: string) => DelegationRunRow[];
  conversations?: { service: ConversationService; repo: ConversationRepo };
  /** 会話の組織 (子会社 id、本社は "")。 送信側の申告ではなく担当セッションの記録から決める。 */
  resolveScope?: (sessionId: string) => string;
  now: () => number;
}

export function delegationSidecarRouter(deps: DelegationSidecarApiDeps): Hono {
  const app = new Hono();

  app.post("/route", async (c) => {
    const parsed = RouteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_route_request", detail: parsed.error.flatten() }, 400);
    const decision = await decideSidecarRoute(parsed.data.input, deps.classifier ?? null);
    const row = deps.records.recordRouteDecision({
      parentSessionId: parsed.data.parent_session_id,
      taskReference: parsed.data.task_reference ?? null,
      requestVersion: parsed.data.request_version ?? null,
      decision,
      routeInput: parsed.data.input,
      now: deps.now(),
    });
    return c.json({
      decision_id: row.id,
      route: decision.route,
      reason: decision.reason,
      uncertainty: decision.uncertainty,
      source: decision.source,
      budget_minutes: decision.budgetMinutes,
    });
  });

  app.get("/observation", (c) => {
    const parentSessionId = c.req.query("parent_session_id")?.trim();
    if (!parentSessionId) return c.json({ error: "parent_session_id required" }, 400);
    return c.json(summarizeSidecarObservation({
      parentSessionId,
      runs: deps.listRunsByParentSession(parentSessionId),
      invokeEvents: deps.records.listInvokeEvents(parentSessionId, 500),
      routeDecisions: deps.records.listRouteDecisions(parentSessionId, 500),
    }));
  });

  app.post("/conversations/ingress", async (c) => {
    if (!deps.conversations) return c.json({ action: "passthrough" });
    const parsed = IngressSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_ingress", detail: parsed.error.flatten() }, 400);
    const input = parsed.data;
    return c.json(deps.conversations.service.accept({
      platform: input.platform,
      scope: deps.resolveScope?.(input.bound_session_id) ?? input.scope,
      guildId: input.guild_id,
      threadId: input.thread_id,
      messageId: input.message_id,
      authorId: input.author_id,
      authorLabel: input.author_label ?? null,
      text: input.text,
      boundSessionId: input.bound_session_id,
      canControlSession: input.can_control_session,
    }));
  });

  app.post("/conversations/inputs/:id/delivery", async (c) => {
    if (!deps.conversations) return c.json({ error: "conversations_unavailable" }, 503);
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: "invalid_input_id" }, 400);
    const parsed = DeliverySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_delivery" }, 400);
    const row = deps.conversations.service.reportDelivery(id, parsed.data.outcome, parsed.data.error ?? null);
    return row ? c.json({ ok: true, state: row.state }) : c.json({ error: "input_not_delivering" }, 409);
  });

  app.get("/conversations/:id", (c) => {
    if (!deps.conversations) return c.json({ error: "conversations_unavailable" }, 503);
    const repo = deps.conversations.repo;
    const conversation = repo.findConversation(c.req.param("id"));
    if (!conversation) return c.json({ error: "not_found" }, 404);
    const inputs = repo.listInputs(conversation.conversation_id,
      ["received", "delivering", "held", "uncertain", "failed", "rejected"], 200)
      .map(({ text: _text, ...rest }) => rest);
    return c.json({
      conversation,
      open_inputs: inputs,
      handoffs: repo.listHandoffsByConversation(conversation.conversation_id)
        .map(({ package_json: packageJson, next_instruction: _next, ...rest }) => ({ ...rest, has_package: packageJson !== null })),
    });
  });

  app.post("/handoffs/:id/package", async (c) => {
    if (!deps.conversations) return c.json({ error: "conversations_unavailable" }, 503);
    const parsed = PackageSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_package_request", detail: parsed.error.flatten() }, 400);
    const result = await deps.conversations.service.savePackage(c.req.param("id"), parsed.data.session_id, parsed.data.package);
    if (result.ok) return c.json({ ok: true, state: result.handoff.state });
    const status = result.error === "handoff_not_found" ? 404
      : result.error === "not_handoff_owner" ? 403
        : result.error === "invalid_package" ? 400 : 409;
    return c.json({ error: result.error, issues: result.issues, holds: result.holds }, status);
  });

  app.post("/handoffs/:id/advance", async (c) => {
    if (!deps.conversations) return c.json({ error: "conversations_unavailable" }, 503);
    const handoff = await deps.conversations.service.advance(c.req.param("id"));
    return handoff ? c.json({ state: handoff.state, error: handoff.error }) : c.json({ error: "not_found" }, 404);
  });

  return app;
}
