/**
 * /v1/reports API.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ConcordiaConfig } from "../shared/config.js";
import { generateReport } from "../report/generator.js";

const AppendSchema = z.object({
  role: z.string().min(1).max(64).optional(),
  monologue: z.string().min(1).max(8000),
});

export interface ReportsApiDeps {
  repo: SessionsRepo;
  config: ConcordiaConfig;
}

export function reportsRouter(deps: ReportsApiDeps): Hono {
  const app = new Hono();

  app.get("/:session_id", (c) => {
    const id = c.req.param("session_id");
    const r = deps.repo.findReport(id);
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json({
      session_id: r.session_id,
      generated_at: r.generated_at,
      duration_sec: r.duration_sec,
      summary_md: r.summary_md,
      bullets: safeParse(r.bullets),
    });
  });

  app.post("/:session_id/regenerate", async (c) => {
    const id = c.req.param("session_id");
    const s = deps.repo.findSession(id);
    if (!s) return c.json({ error: "not_found" }, 404);
    const events = deps.repo.allEvents(id);
    const report = await generateReport(s, events, {
      apiKey: deps.config.anthropicApiKey,
      model: deps.config.reportModel,
    });
    deps.repo.upsertReport(report);
    return c.json({
      session_id: report.session_id,
      generated_at: report.generated_at,
      duration_sec: report.duration_sec,
      summary_md: report.summary_md,
      bullets: safeParse(report.bullets),
    });
  });

  app.post("/:session_id/append", async (c) => {
    const id = c.req.param("session_id");
    const r = deps.repo.findReport(id);
    if (!r) return c.json({ error: "report_not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = AppendSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const heading = parsed.data.role ? `## 今日の${parsed.data.role}より` : `## 感想`;
    const sep = r.summary_md.endsWith("\n") ? "\n" : "\n\n";
    const updated = `${r.summary_md}${sep}${heading}\n\n${parsed.data.monologue}\n`;
    deps.repo.upsertReport({ ...r, summary_md: updated });
    return c.json({ ok: true });
  });

  // DELETE /v1/reports/:session_id — 単発削除 (human 操作)
  app.delete("/:session_id", (c) => {
    const id = c.req.param("session_id");
    const ok = deps.repo.deleteReport(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  // GET /v1/reports — list 全レポート (Web UI 用)
  app.get("/", (c) => {
    const limit = Number(c.req.query("limit") ?? "30");
    const list = deps.repo.listReports(limit);
    return c.json({
      reports: list.map((r) => ({
        session_id: r.session_id,
        generated_at: r.generated_at,
        duration_sec: r.duration_sec,
        bullets: safeParse(r.bullets),
        summary_preview: r.summary_md.length > 240 ? r.summary_md.slice(0, 240) + "…" : r.summary_md,
      })),
    });
  });

  return app;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
