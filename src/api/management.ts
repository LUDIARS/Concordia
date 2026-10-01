import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ManagementInputError, isHumanAction } from "../management/domain.js";
import { ManagementError, publicMission, type ManagementService } from "../management/service.js";

/**
 * CDGD マネジメント層の HTTP (spec/feature/cdgd-management.md)。
 *
 * - `managementRouter` (/v1/management): dots 向け (Bearer トークン必須)、変更の受付口、
 *   担当セッションの成果記録。 dots のトークンで呼べるのは CC-MGMT-03 の操作だけ。
 * - `managementAdminRouter` (/v1/admin/management): 人間の管理面。 任務の管理と、
 *   承認・却下・受入・効果確認。 他の /v1/admin/* と同じ loopback 信頼境界に乗る。
 */

type Body = Record<string, unknown>;

async function readBody(c: Context): Promise<Body> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ManagementInputError("invalid_body", "JSON object が必要です");
  }
  return body as Body;
}

function bearer(c: Context): string | null {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

function handle(c: Context, error: unknown) {
  if (error instanceof ManagementError) return c.json({ error: error.code, message: error.message }, error.status);
  if (error instanceof ManagementInputError) return c.json({ error: error.code, message: error.message }, 400);
  throw error;
}

function intQuery(raw: string | undefined, fallback: number | null, min: number, max: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ManagementInputError("invalid_query", `query は ${min}〜${max} の整数です`);
  }
  return value;
}

export function managementRouter(service: ManagementService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); });

  // 変更の受付口 (サービス → Cc)。 loopback 信頼境界。
  app.post("/events", async (c) => {
    try {
      const result = service.ingestEvent(await readBody(c));
      return c.json(result, result.created ? 201 : 200);
    } catch (error) { return handle(c, error); }
  });

  // 担当セッションの成果記録。 本人照合は service が session_id で行う。
  app.post("/requests/:id/outcome", async (c) => {
    try {
      return c.json({ request: service.recordOutcome(c.req.param("id"), await readBody(c)) });
    } catch (error) { return handle(c, error); }
  });

  registerDotsRoutes(app, service);
  return app;
}

/** dots の認証失敗を数える guard。 dots 専用の入口 (CC-MGMT-07) だけが渡す。 */
export interface DotsAuthGuard {
  /** 窓内の失敗が上限を超えた送信元なら true。 */
  isLimited(c: Context): boolean;
  recordFailure(c: Context): void;
}

/**
 * dots 向けの 6 操作 (CC-MGMT-03)。 Bearer トークン必須。 本体の /v1/management と
 * dots 専用の入口の両方がこれだけを共有する。
 */
export function registerDotsRoutes(app: Hono, service: ManagementService, guard?: DotsAuthGuard): void {
  const authenticate = (c: Context) => {
    if (guard?.isLimited(c)) throw new ManagementError("rate_limited", "認証失敗が多すぎます。しばらく待ってください", 429);
    try {
      return service.authenticate(bearer(c));
    } catch (error) {
      if (error instanceof ManagementError && error.code === "unauthorized") guard?.recordFailure(c);
      throw error;
    }
  };

  app.get("/context", (c) => {
    try {
      return c.json(service.context(authenticate(c)));
    } catch (error) { return handle(c, error); }
  });

  app.get("/changes", (c) => {
    try {
      const mission = authenticate(c);
      const after = intQuery(c.req.query("after"), null, 0, Number.MAX_SAFE_INTEGER);
      const limit = intQuery(c.req.query("limit"), 100, 1, 500)!;
      return c.json(service.changes(mission, after, limit));
    } catch (error) { return handle(c, error); }
  });

  app.post("/decisions", async (c) => {
    try {
      const mission = authenticate(c);
      const result = service.recordDecision(mission, await readBody(c));
      return c.json(result, result.created ? 201 : 200);
    } catch (error) { return handle(c, error); }
  });

  app.post("/requests", async (c) => {
    try {
      const mission = authenticate(c);
      const result = service.submitRequest(mission, await readBody(c));
      return c.json(result, result.created ? 201 : 200);
    } catch (error) { return handle(c, error); }
  });

  app.get("/requests/:key", (c) => {
    try {
      const mission = authenticate(c);
      return c.json({ request: service.getRequest(mission, c.req.param("key")) });
    } catch (error) { return handle(c, error); }
  });

  app.post("/acknowledge", async (c) => {
    try {
      const mission = authenticate(c);
      return c.json(service.acknowledge(mission, await readBody(c)));
    } catch (error) { return handle(c, error); }
  });
}

/** dots 専用の入口用: 6 操作だけを /v1/management に載せ、 他は全部 404。 */
export function managementRemoteApp(service: ManagementService, guard: DotsAuthGuard, maxBodyBytes: number): Hono {
  const app = new Hono();
  const api = new Hono();
  api.use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); });
  api.use("*", bodyLimit({ maxSize: maxBodyBytes, onError: (c) => c.json({ error: "payload_too_large" }, 413) }));
  registerDotsRoutes(api, service, guard);
  app.route("/v1/management", api);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}

export function managementAdminRouter(service: ManagementService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); });

  app.get("/missions", (c) => c.json({ missions: service.repo.listMissions().map(publicMission) }));

  app.post("/missions", async (c) => {
    try {
      const { mission, token } = service.createMission(await readBody(c));
      // トークン平文はこの応答でだけ返す。
      return c.json({ mission: publicMission(mission), token }, 201);
    } catch (error) { return handle(c, error); }
  });

  app.patch("/missions/:id", async (c) => {
    try {
      return c.json({ mission: publicMission(service.updateMission(c.req.param("id"), await readBody(c))) });
    } catch (error) { return handle(c, error); }
  });

  app.post("/missions/:id/stop", (c) => {
    try {
      return c.json({ mission: publicMission(service.setMissionStatus(c.req.param("id"), "stopped")) });
    } catch (error) { return handle(c, error); }
  });

  app.post("/missions/:id/resume", (c) => {
    try {
      return c.json({ mission: publicMission(service.setMissionStatus(c.req.param("id"), "active")) });
    } catch (error) { return handle(c, error); }
  });

  app.post("/missions/:id/token", (c) => {
    try {
      const { mission, token } = service.rotateToken(c.req.param("id"));
      return c.json({ mission: publicMission(mission), token });
    } catch (error) { return handle(c, error); }
  });

  app.get("/requests", (c) => {
    try {
      const missionId = c.req.query("mission_id")?.trim() || null;
      const limit = intQuery(c.req.query("limit"), 100, 1, 500)!;
      const items = service.listRequestsWithActions(missionId, limit);
      return c.json({ requests: items.map((item) => ({ ...item.request, mission_name: item.mission_name, actions: item.actions })) });
    } catch (error) { return handle(c, error); }
  });

  // 人間向けカードの配達 (CC-MGMT-06)。 Discord 配達側が読み、 送った revision を返す。
  app.get("/deliveries", (c) => {
    const items = service.deliveries();
    return c.json({ deliveries: items.map((item) => ({ ...item.request, mission_name: item.mission_name, actions: item.actions })) });
  });

  app.post("/requests/:id/delivery", async (c) => {
    try {
      return c.json({ request: service.recordDelivery(c.req.param("id"), await readBody(c)) });
    } catch (error) { return handle(c, error); }
  });

  app.post("/requests/:id/:action", async (c) => {
    try {
      const action = c.req.param("action");
      if (!isHumanAction(action)) return c.json({ error: "unknown_action" }, 404);
      return c.json({ request: service.humanAction(c.req.param("id"), action, await readBody(c)) });
    } catch (error) { return handle(c, error); }
  });

  return app;
}
