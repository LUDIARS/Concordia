/**
 * /v1/processes — Concordia 管理プロセスの起動 / 停止 / ログ pull / 行ストリーム.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { eventBus } from "../events.js";
import type { ProcessManager } from "../processes/manager.js";
import type { ProcessesRepo } from "../db/processes-repo.js";
import type { ProcessRow } from "../shared/types.js";

export interface ProcessesApiDeps {
  manager: ProcessManager;
  repo: ProcessesRepo;
}

const StartFromRepoSchema = z.object({
  repo_path: z.string().min(1),
  repo_origin: z.string().nullable().optional(),
});

export function processesRouter(deps: ProcessesApiDeps): Hono {
  const app = new Hono();

  // GET /v1/processes  — 一覧 (?status= / ?repo_path=)
  app.get("/", (c) => {
    const q = c.req.query();
    const list = deps.repo.list({
      status: (q.status as ProcessRow["status"]) || undefined,
      repo_path: q.repo_path || undefined,
    });
    return c.json({
      processes: list.map((row) => ({
        ...serializeProcess(row),
        live: deps.manager.isRunning(row.name),
      })),
    });
  });

  // POST /v1/processes/start-from-repo  — dev-process.md auto-start
  app.post("/start-from-repo", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = StartFromRepoSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const result = await deps.manager.startFromRepo(parsed.data.repo_path, parsed.data.repo_origin ?? null);
    return c.json(result);
  });

  // GET /v1/processes/:name  — 詳細 + 直近ログ
  app.get("/:name", (c) => {
    const name = c.req.param("name");
    const row = deps.repo.find(name);
    if (!row) return c.json({ error: "not_found" }, 404);
    const logs = deps.repo.recentLogs(name, { limit: 50 });
    return c.json({
      process: { ...serializeProcess(row), live: deps.manager.isRunning(name) },
      recent_logs: logs,
    });
  });

  // POST /v1/processes/:name/stop
  app.post("/:name/stop", async (c) => {
    const name = c.req.param("name");
    const r = await deps.manager.stopOne(name);
    if (!r.ok) return c.json({ ok: false, reason: r.reason }, 409);
    return c.json({ ok: true });
  });

  // GET /v1/processes/:name/logs?since_ts=&level=&limit=
  app.get("/:name/logs", (c) => {
    const name = c.req.param("name");
    if (!deps.repo.find(name)) return c.json({ error: "not_found" }, 404);
    const q = c.req.query();
    const since = q.since_ts ? Number(q.since_ts) : undefined;
    const level = q.level ? (q.level as "error" | "warn" | "info") : undefined;
    const limit = q.limit ? Number(q.limit) : undefined;
    const logs = deps.repo.recentLogs(name, {
      since_ts: Number.isFinite(since!) ? since : undefined,
      level,
      limit: Number.isFinite(limit!) ? limit : undefined,
    });
    return c.json({ logs });
  });

  // GET /v1/processes/:name/stream  — SSE で当該プロセスのログのみ
  app.get("/:name/stream", (c) => {
    const name = c.req.param("name");
    if (!deps.repo.find(name)) return c.json({ error: "not_found" }, 404);
    return streamSSE(c, async (stream) => {
      const id0 = Math.floor(Date.now() / 1000);
      let counter = id0;
      let closed = false;

      // 接続直後に直近ログを backfill (新→古→新の順で送り出すため reverse).
      const backfill = deps.repo.recentLogs(name, { limit: 100 });
      for (const l of backfill) {
        counter += 1;
        await stream.writeSSE({
          id: String(counter),
          event: "process.log",
          data: JSON.stringify({
            type: "process.log",
            process_name: l.process_name,
            stream: l.stream,
            line: l.line,
            level: l.level ?? undefined,
            ts: l.ts,
            backfill: true,
          }),
        });
      }

      const unsub = eventBus.subscribe((ev) => {
        if (closed) return;
        if (ev.type === "process.log" && ev.process_name === name) {
          counter += 1;
          void stream.writeSSE({
            id: String(counter),
            event: "process.log",
            data: JSON.stringify(ev),
          });
          return;
        }
        if (ev.type === "process.exited" && ev.process_name === name) {
          counter += 1;
          void stream.writeSSE({
            id: String(counter),
            event: "process.exited",
            data: JSON.stringify(ev),
          });
        }
      });

      const ping = setInterval(() => {
        if (closed) return;
        counter += 1;
        void stream.writeSSE({
          id: String(counter),
          event: "ping",
          data: JSON.stringify({ ts: Math.floor(Date.now() / 1000) }),
        });
      }, 15_000);

      stream.onAbort(() => {
        closed = true;
        clearInterval(ping);
        unsub();
      });

      while (!closed) {
        await stream.sleep(1000);
      }
    });
  });

  return app;
}

export function serializeProcess(row: ProcessRow) {
  let metadata: unknown = null;
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata); } catch { metadata = row.metadata; }
  }
  return {
    name: row.name,
    cwd: row.cwd,
    command: row.command,
    repo_path: row.repo_path,
    repo_origin: row.repo_origin,
    pid: row.pid,
    status: row.status,
    started_at: row.started_at,
    exited_at: row.exited_at,
    exit_code: row.exit_code,
    exit_signal: row.exit_signal,
    log_path: row.log_path,
    metadata,
  };
}
