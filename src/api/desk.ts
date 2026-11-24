/**
 * /v1/desk — 依頼窓口の API (loopback / 既存の Web SSO の範囲、CC-V5-INV-06)。
 * Web と Discord の受付は同じ POST を呼ぶ (CC-V5-INV-07)。
 *
 * - POST /v1/desk/requests      受付 (受付キーで冪等)
 * - GET  /v1/desk/requests      一覧 (新しい順)
 * - GET  /v1/desk/requests/:id  詳細 (開いているカード・セッションへのリンク)
 *
 * @implements spec/feature/request-desk.md — API
 */
import { Hono } from "hono";
import { z } from "zod";
import { DESK_BODY_MAX_CHARS, webRequestKey, type DeskRequest } from "../desk/desk-request-policy.js";
import type { DeskService } from "../desk/service.js";

const SubmitSchema = z.object({
  client_request_id: z.string().min(1).max(100).optional(),
  request_key: z.string().min(1).max(120).optional(),
  body: z.string().min(1).max(DESK_BODY_MAX_CHARS * 4),
  provider: z.enum(["claude", "codex"]).default("claude"),
  requester: z.string().max(200).optional(),
}).strict().refine((value) => Boolean(value.client_request_id) !== Boolean(value.request_key), "client_request_id か request_key のどちらか 1 つ");

export interface DeskCardSummary {
  id: string;
  card_kind: string;
  summary: string;
  state: string;
  priority: string;
  raised_at: number;
  closed_at: number | null;
}

export interface DeskApiDeps {
  service: DeskService;
  /** そのセッションのカード (開閉とも)。 */
  cardsForSession?: (sessionId: string) => DeskCardSummary[];
  /** セッションの Discord チャンネル URL と Web チャットのパス。 */
  sessionLinks?: (sessionId: string) => { discord: string | null; web: string };
}

function view(deps: DeskApiDeps, request: DeskRequest) {
  const cards = request.session_id ? deps.cardsForSession?.(request.session_id) ?? [] : [];
  return {
    ...request,
    open_cards: cards.filter((card) => card.state === "open").length,
    links: request.session_id ? deps.sessionLinks?.(request.session_id) ?? { discord: null, web: `/sessions/${request.session_id}` } : null,
  };
}

export function deskRouter(deps: DeskApiDeps): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); });

  app.post("/requests", async (c) => {
    const parsed = SubmitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", detail: parsed.error.issues.map((issue) => issue.message) }, 400);
    const { client_request_id, request_key, body, provider, requester } = parsed.data;
    const key = request_key ?? webRequestKey(client_request_id!);
    if (!key) return c.json({ error: "invalid_request", detail: ["client_request_id は 8〜100 文字の英数字・-_"] }, 400);
    const outcome = deps.service.submit({ requestKey: key, requester: requester ?? (request_key ? "discord" : "web"), provider, body });
    if (outcome.kind === "invalid") return c.json({ error: "invalid_request", detail: [outcome.problem] }, 400);
    if (outcome.kind === "disabled") return c.json({ error: "desk_disabled" }, 503);
    if (outcome.kind === "conflict") return c.json({ error: "request_key_reused", request: view(deps, outcome.request) }, 409);
    return c.json({ request: view(deps, outcome.request), existing: outcome.kind === "existing" }, outcome.kind === "created" ? 202 : 200);
  });

  app.get("/requests", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const rows = deps.service.list(Number.isInteger(limit) ? limit : 50);
    return c.json({ requests: rows.map((row) => view(deps, row)) });
  });

  app.get("/requests/:id", (c) => {
    const request = deps.service.get(c.req.param("id"));
    if (!request) return c.json({ error: "not_found" }, 404);
    return c.json({
      request: view(deps, request),
      cards: request.session_id ? deps.cardsForSession?.(request.session_id) ?? [] : [],
    });
  });

  return app;
}
