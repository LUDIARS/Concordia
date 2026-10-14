/**
 * デイリーゴールの HTTP。
 *
 * @implements spec/feature/daily-goal-run.md — HTTP / CC-DG-INV-01 / CC-DG-INV-03
 *
 * 読み取り (一覧・詳細・業務日の状態) だけを持つ。 セッションからの報告 API は 2026-10-14 に撤廃した
 * (進み具合は Cc のワンショット判定で見る)。 登録・停止・まとめの再送は人間の判断なので HTTP には
 * 設けない (Discord の本人操作の内部呼び出しに限る)。 loopback 限定。
 */

import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { bodyLimit } from "hono/body-limit";
import { DailyGoalConflict } from "../daily-goal-run/domain.js";
import type { DailyGoalRunService } from "../daily-goal-run/service.js";
import { workflowGate } from "../workflow/api-gate.js";

const STATUS_BY_CODE: Record<string, 403 | 404 | 409> = { forbidden: 403, not_found: 404 };

export function dailyGoalRunRouter(service: DailyGoalRunService, opts: { isEnabled: () => boolean; localRequest?: () => boolean }): Hono {
  const app = new Hono();
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
  app.get("/days/:date", (c) => {
    const date = c.req.param("date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    return c.json(service.dayDetail(date));
  });
  app.get("/:id", (c) => {
    const detail = service.detail(c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: "daily goal not found" }, 404);
  });
  return app;
}
