/**
 * /v1/daily-reports API.
 */

import { Hono } from "hono";
import type { DayReportsRepo } from "../db/day-reports-repo.js";
import type { SchedulerHandle } from "../daily/scheduler.js";
import { dayRange } from "../daily/aggregator.js";

export interface DailyApiDeps {
  dayReports: DayReportsRepo;
  scheduler: SchedulerHandle;
}

export function dailyRouter(deps: DailyApiDeps): Hono {
  const app = new Hono();

  // GET /v1/daily-reports — list (新しい順、 上限 30)
  app.get("/", (c) => {
    const limit = Number(c.req.query("limit") ?? "30");
    return c.json({
      reports: deps.dayReports.list(limit).map(serialize),
    });
  });

  // GET /v1/daily-reports/:date — date は YYYY-MM-DD or "today" / "yesterday"
  app.get("/:date", (c) => {
    const date = resolveDate(c.req.param("date"));
    const r = deps.dayReports.find(date);
    if (!r) return c.json({ error: "not_found", hint: "POST /:date/generate でまず生成" }, 404);
    return c.json(serialize(r));
  });

  // POST /v1/daily-reports/:date/generate — 強制 (再) 生成
  app.post("/:date/generate", async (c) => {
    const date = resolveDate(c.req.param("date"));
    await deps.scheduler.runOnce(date);
    const r = deps.dayReports.find(date);
    if (!r) return c.json({ error: "still no report (maybe no sessions that day)" }, 404);
    return c.json(serialize(r));
  });

  return app;
}

function resolveDate(input: string): string {
  if (input === "today") return dayRange(new Date()).iso;
  if (input === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return dayRange(d).iso;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error("date must be YYYY-MM-DD or today / yesterday");
  }
  return input;
}

function serialize(r: { date_iso: string; generated_at: number; summary_md: string; bullets: string; session_count: number; total_duration_sec: number; metadata: string | null }) {
  return {
    date_iso: r.date_iso,
    generated_at: r.generated_at,
    summary_md: r.summary_md,
    bullets: safeParse(r.bullets),
    session_count: r.session_count,
    total_duration_sec: r.total_duration_sec,
    metadata: r.metadata ? safeParse(r.metadata) : null,
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
