/**
 * `session_messages` の読み出し + client 既読位置 API
 * (spec/feature/session-message-layer.md §5)。
 *
 * 書き込みは `src/messages/service.ts` が eventBus 購読で行う — ここは REST 読み出しのみ。
 */

import type { Hono } from "hono";
import { z } from "zod";
import type { SessionsApiDeps } from "./deps.js";
import { nowSec } from "./shared.js";

const ClientIdSchema = z.string().min(1).max(128);
const CursorSchema = z.number().int().safe().nonnegative();
const QueryCursorSchema = z.coerce.number().int().safe().nonnegative();

const ListQuerySchema = z.object({
  before: QueryCursorSchema.positive().optional(),
  after: QueryCursorSchema.optional(),
  limit: z.coerce.number().int().safe().positive().optional(),
}).refine((query) => query.before === undefined || query.after === undefined, {
  message: "before and after cannot be combined",
});

const UnreadQuerySchema = z.object({
  client_id: ClientIdSchema,
});

const ReadSchema = z.object({
  client_id: ClientIdSchema,
  last_read_id: CursorSchema,
});

export function registerMessagesRoutes(app: Hono, deps: SessionsApiDeps): void {
  app.get("/:id/links", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    if (!deps.delegation) return c.json({ error: "delegation_unavailable" }, 503);

    const parents = deps.delegation.listRunsByChildSession(id)
      .filter((run) => run.parent_session_id !== null)
      .map((run) => ({
        run_id: run.id,
        session_id: run.parent_session_id,
        child_session_id: run.child_session_id,
        status: run.status,
      }));
    const children = deps.delegation.listRunsByParentSession(id)
      .filter((run) => run.child_session_id !== null)
      .map((run) => ({
        run_id: run.id,
        session_id: run.child_session_id,
        parent_session_id: run.parent_session_id,
        status: run.status,
      }));
    return c.json({ parents, children });
  });

  app.get("/:id/messages", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const query = ListQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: query.error.message }, 400);
    const messages = deps.sessionMessages.list(id, query.data);
    return c.json({ messages });
  });

  app.get("/:id/messages/unread", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const query = UnreadQuerySchema.safeParse({ client_id: c.req.query("client_id") });
    if (!query.success) return c.json({ error: query.error.message }, 400);
    const read = deps.sessionMessageReads.get(query.data.client_id, id);
    const lastReadId = read?.last_read_id ?? 0;
    const unread = deps.sessionMessages.countAfter(id, lastReadId);
    return c.json({ last_read_id: lastReadId, unread });
  });

  app.post("/:id/messages/read", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = ReadSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const latestId = deps.sessionMessages.latest(id)?.id ?? 0;
    const lastReadId = Math.min(parsed.data.last_read_id, latestId);
    deps.sessionMessageReads.upsert(parsed.data.client_id, id, lastReadId, nowSec());
    const stored = deps.sessionMessageReads.get(parsed.data.client_id, id);
    return c.json({ ok: true, last_read_id: stored?.last_read_id ?? 0 });
  });
}
