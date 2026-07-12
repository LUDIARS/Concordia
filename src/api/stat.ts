/**
 * /v1/stat — session stat snapshot API.
 *
 * - POST /v1/stat/:session_id  — session が自身の現況を JSON で投稿
 * - GET  /v1/stat              — 全 session の最新 stat を一覧 (フラットチーム閲覧)
 * - GET  /v1/stat/:session_id  — 指定 session の最新 + 履歴
 *
 * 認証は loopback 想定で無し. session 存在チェックのみ.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { StatsRepo } from "../db/stats-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { serializeSession } from "./sessions.js";
import { eventBus } from "../events.js";

const PostStatSchema = z.object({
  /**
   * セッション現況の自由 JSON. AI が /stat --json で吐く形式を想定.
   * 期待される代表的なキー (どれも任意):
   *  - active_repos: [{ repo: string, branch: string, uncommitted: number, unpushed: number }]
   *  - open_prs:     [{ repo: string, number: number, title: string, branch: string }]
   *  - unmerged_branches: [{ repo: string, branch: string }]
   *  - todos_summary: string
   *  - recent_work:   string
   *  - note:          string
   */
  payload: z.record(z.unknown()),
  /** session 側で計測した ts (秒). 未指定なら server now. */
  ts: z.number().int().positive().optional(),
});

export interface StatApiDeps {
  stats: StatsRepo;
  sessions: SessionsRepo;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export function statRouter(deps: StatApiDeps): Hono {
  const app = new Hono();

  // 全 session の latest stat (フラットチーム閲覧入口)
  app.get("/", (c) => {
    const rows = deps.stats.latestPerSession();
    const enriched = rows.map((r) => {
      const session = deps.sessions.findSession(r.session_id);
      return {
        session_id: r.session_id,
        latest_ts: r.latest_ts,
        payload: safeParse(r.payload),
        session: session ? serializeSession(session) : null,
      };
    });
    return c.json({ items: enriched });
  });

  // 指定 session の latest + 履歴
  app.get("/:session_id", (c) => {
    const sessionId = c.req.param("session_id");
    const session = deps.sessions.findSession(sessionId);
    if (!session) return c.json({ error: "session not found" }, 404);
    const latest = deps.stats.latest(sessionId);
    const history = deps.stats.history(sessionId, 50);
    return c.json({
      session: serializeSession(session),
      latest: latest ? { id: latest.id, ts: latest.ts, payload: safeParse(latest.payload) } : null,
      history: history.map((h) => ({ id: h.id, ts: h.ts, payload: safeParse(h.payload) })),
    });
  });

  // session が自身の stat を POST
  app.post("/:session_id", async (c) => {
    const sessionId = c.req.param("session_id");
    const session = deps.sessions.findSession(sessionId);
    if (!session) return c.json({ error: "session not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PostStatSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    if (session.status === "active") {
      deps.sessions.updateHeartbeat(sessionId, Math.floor(Date.now() / 1000));
    }

    const row = deps.stats.insert({
      session_id: sessionId,
      ts: parsed.data.ts,
      payload: parsed.data.payload,
    });

    eventBus.emit({
      type: "stat.collected",
      session_id: sessionId,
      stat_id: row.id,
      ts: row.ts,
    });

    return c.json({ ok: true, id: row.id, ts: row.ts });
  });

  return app;
}
