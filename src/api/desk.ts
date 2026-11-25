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
  project: z.string().trim().min(1).max(100).optional(),
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
  cardsForRequest?: (requestId: string) => DeskCardSummary[];
  /** セッションの Discord チャンネル URL と Web チャットのパス。 */
  sessionLinks?: (sessionId: string) => { discord: string | null; web: string };
}

function requestCards(deps: DeskApiDeps, request: DeskRequest): DeskCardSummary[] {
  const childSession = request.task_reference ? deps.service.delegationRun(request.id)?.childSessionId : null;
  return [
    ...(deps.cardsForRequest?.(request.id) ?? []),
    ...(request.session_id && (!request.routing_enabled || request.delivery === "claimed")
      ? deps.cardsForSession?.(request.session_id) ?? [] : []),
    ...(childSession && childSession !== request.session_id ? deps.cardsForSession?.(childSession) ?? [] : []),
  ];
}

function view(deps: DeskApiDeps, request: DeskRequest) {
  const run = request.task_reference ? deps.service.delegationRun(request.id) : null;
  return {
    id: request.id, request_key: request.request_key, origin: request.origin, requester: request.requester,
    provider: request.provider, body: request.body, state: request.state, spawn_id: request.spawn_id,
    session_id: request.session_id, launch_deadline_at: request.launch_deadline_at, error: request.error,
    discord_thread_id: request.discord_thread_id, created_at: request.created_at, updated_at: request.updated_at,
    revision: request.revision, project_code: request.project_code, task_reference: request.task_reference,
    routing_issue: request.routing_issue, delivery: request.delivery,
    ...(run ? { delegation_run_id: run.id, child_session_id: run.childSessionId } : {}),
    open_cards: requestCards(deps, request).filter((card) => card.state === "open").length,
    links: request.session_id ? deps.sessionLinks?.(request.session_id) ?? { discord: null, web: `/sessions/${request.session_id}` } : null,
  };
}

export function deskRouter(deps: DeskApiDeps): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); });

  app.post("/requests", async (c) => {
    const parsed = SubmitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", detail: parsed.error.issues.map((issue) => issue.message) }, 400);
    const { client_request_id, request_key, body, provider, requester, project } = parsed.data;
    const key = request_key ?? webRequestKey(client_request_id!);
    if (!key) return c.json({ error: "invalid_request", detail: ["client_request_id は 8〜100 文字の英数字・-_"] }, 400);
    const outcome = deps.service.submit({ requestKey: key, requester: requester ?? (request_key ? "discord" : "web"), provider, body,
      ...(project === undefined ? {} : { project }) });
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
      gen5Stage: request.session_id ? deps.service.repo.gen5Stage(request.session_id) : null,
      projects: request.routing_issue === "project" ? deps.service.projects() : [],
      cards: requestCards(deps, request),
    });
  });

  app.post("/requests/:id/project", async (c) => {
    const parsed = z.object({ project: z.string().trim().min(1).max(100) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_project" }, 400);
    const request = deps.service.selectProject(c.req.param("id"), parsed.data.project);
    return request ? c.json({ request: view(deps, request) }) : c.json({ error: "project_selection_unavailable" }, 409);
  });

  app.post("/requests/:id/retry-launch", (c) => {
    const request = deps.service.retryLaunch(c.req.param("id"));
    return request ? c.json({ request: view(deps, request) }) : c.json({ error: "launch_retry_unavailable" }, 409);
  });

  app.post("/requests/:id/claim", async (c) => {
    const parsed = z.object({ session_id: z.string().trim().min(1).max(200) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_session" }, 400);
    const request = deps.service.claim(c.req.param("id"), parsed.data.session_id);
    return request ? c.json({ task_reference: request.task_reference }) : c.json({ error: "claim_unavailable" }, 409);
  });

  return app;
}
