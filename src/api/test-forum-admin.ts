/**
 * Test フォーラムの運用操作 (loopback /v1)。
 *
 * - POST /purge-closed `{ subsidiary_id: string | null }` — その会社 (本社 = null) の Test フォーラムで閉じた
 *   スレッドを一括削除する。削除はその会社の Bot が discord.test_forum.purge_closed_requested を受けて行う
 *   (受付だけ返す、 2026-10-06 neco 指示)。
 *
 * @implements spec/feature/revisor-test-forum-sync.md §閉じたスレッドの一括削除
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { ConcordiaEvent } from "../events.js";

const PurgeSchema = z.object({ subsidiary_id: z.string().min(1).max(100).nullable() }).strict();

export function testForumAdminRouter(deps: { emit(event: ConcordiaEvent): void; now?: () => number }): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  app.post("/purge-closed", async (c) => {
    const parsed = PurgeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    deps.emit({
      type: "discord.test_forum.purge_closed_requested",
      event_id: randomUUID(),
      subsidiary_id: parsed.data.subsidiary_id,
      ts: Math.floor(now() / 1000),
    });
    return c.json({ accepted: true, subsidiary_id: parsed.data.subsidiary_id }, 202);
  });
  return app;
}
