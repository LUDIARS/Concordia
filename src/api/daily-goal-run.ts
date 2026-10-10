/**
 * デイリーゴール自走の HTTP。
 *
 * @implements spec/feature/daily-goal-run.md — 5. 確認 / 6. 終わり方 / CC-DG-INV-01 / CC-DG-INV-03
 *
 * 読み取り (一覧・詳細) と、 専用セッションからの報告 (到達・やり切り・報告文) だけを持つ。
 * 報告を呼べるのは紐付いた session_id のセッションだけ。 確定と停止は人間の判断なので
 * HTTP には設けない (Discord の本人操作の内部呼び出しに限る)。 loopback 限定。
 */

import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { DailyGoalConflict, type RemainingItem } from "../daily-goal-run/domain.js";
import type { DailyGoalRunService } from "../daily-goal-run/service.js";
import { workflowGate } from "../workflow/api-gate.js";

const sessionId = z.string().min(1).max(200);
const reachedSchema = z.object({
  session_id: sessionId,
  evidence: z.array(z.object({ item: z.string().min(1).max(2000), refs: z.array(z.string().min(1).max(500)).max(50) })).max(50),
  report: z.string().max(4000).optional(),
});
const remainingSchema = z.discriminatedUnion("class", [
  z.object({ item: z.string().min(1).max(2000), class: z.literal("unachievable"), reason: z.string().max(2000) }),
  z.object({ item: z.string().min(1).max(2000), class: z.literal("human_judgment"), question_id: z.number().int().positive().optional(), human_wait: z.boolean().optional() }),
  z.object({ item: z.string().min(1).max(2000), class: z.literal("doable"), note: z.string().max(2000).optional() }),
]);
const exhaustedSchema = z.object({ session_id: sessionId, remaining: z.array(remainingSchema).max(50), report: z.string().max(4000).optional() });
const reportSchema = z.object({ session_id: sessionId, report: z.string().min(1).max(4000) });

const STATUS_BY_CODE: Record<string, 403 | 404 | 409> = { forbidden: 403, not_found: 404 };

function toRemaining(items: z.infer<typeof exhaustedSchema>["remaining"]): RemainingItem[] {
  return items.map((item): RemainingItem => {
    if (item.class === "unachievable") return { item: item.item, class: "unachievable", reason: item.reason };
    if (item.class === "doable") return { item: item.item, class: "doable", ...(item.note ? { note: item.note } : {}) };
    return { item: item.item, class: "human_judgment",
      ...(item.question_id !== undefined ? { questionId: item.question_id } : {}),
      ...(item.human_wait !== undefined ? { humanWait: item.human_wait } : {}) };
  });
}

/** 判定の結果を返した後の報告文の記録は付随情報なので、記録できなくても判定を取り消さない。 */
function recordQuietly(service: DailyGoalRunService, goalId: string, session: string, report: string): void {
  try { service.recordReport(goalId, session, report); } catch { /* no checkpoint yet */ }
}

export function dailyGoalRunRouter(service: DailyGoalRunService, opts: { isEnabled: () => boolean; localRequest?: () => boolean; now?: () => number }): Hono {
  const app = new Hono();
  const now = opts.now ?? Date.now;
  app.use("*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "daily goal request too large" }, 413) }));
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    let local = false;
    try { local = opts.localRequest ? opts.localRequest() : ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(getConnInfo(c).remote.address ?? ""); } catch { /* no transport identity */ }
    if (!local || ["origin", "sec-fetch-site", "forwarded", "x-forwarded-for", "cf-connecting-ip"].some((h) => c.req.header(h))) {
      return c.json({ error: "local service integration only" }, 403);
    }
    await next();
  });
  app.use("*", workflowGate("daily_goal", opts.isEnabled));
  app.onError((error, c) => error instanceof DailyGoalConflict
    ? c.json({ error: error.message, code: error.code }, STATUS_BY_CODE[error.code] ?? 409)
    : c.json({ error: "daily goal operation failed" }, 500));

  app.get("/", (c) => {
    const date = c.req.query("date");
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    return c.json({ goals: service.list(date) });
  });
  app.get("/:id", (c) => {
    const detail = service.detail(c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: "daily goal not found" }, 404);
  });
  app.post("/:id/reached", async (c) => {
    const body = reachedSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid reached report" }, 400);
    const result = await service.reportReached(c.req.param("id"), body.data.session_id, body.data.evidence, now());
    if (body.data.report && result.outcome === "go") recordQuietly(service, c.req.param("id"), body.data.session_id, body.data.report);
    return c.json(result);
  });
  app.post("/:id/exhausted", async (c) => {
    const body = exhaustedSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid exhausted report" }, 400);
    const result = service.reportExhausted(c.req.param("id"), body.data.session_id, toRemaining(body.data.remaining), now());
    if (body.data.report && result.outcome !== "exhausted") recordQuietly(service, c.req.param("id"), body.data.session_id, body.data.report);
    return c.json(result);
  });
  app.post("/:id/report", async (c) => {
    const body = reportSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid report" }, 400);
    service.recordReport(c.req.param("id"), body.data.session_id, body.data.report);
    return c.json({ ok: true });
  });
  return app;
}
