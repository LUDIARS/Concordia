// @implements CC-ACTIO-CHAT-01
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { proxyChat, type ChatProxyDeps } from "../platform/actio-chat-proxy.js";

export interface ActioChatDeps extends ChatProxyDeps {
  secret(): string;
  review(content: string, titles: string[], signal: AbortSignal): Promise<unknown>;
}
const requestSchema = z.object({ teamId: z.string().min(1).max(200), platform: z.enum(["discord", "slack"]), workspaceId: z.string().min(1).max(100),
  path: z.string().min(1).max(2000), method: z.enum(["GET", "POST", "PATCH"]), body: z.record(z.unknown()).optional() }).strict();
export function actioChatRouter(deps: ActioChatDeps): Hono {
  const app = new Hono();
  let running = 0;
  app.use("*", bodyLimit({ maxSize: 200_000 }));
  app.use("*", async (c, next) => {
    const secret = deps.secret();
    if (!secret) return c.json({ error: "Actio chat integration is not configured" }, 503);
    const actual = Buffer.from(c.req.header("authorization") ?? ""), expected = Buffer.from(`Bearer ${secret}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return c.json({ error: "unauthorized" }, 401);
    if (running >= 4) return c.json({ error: "chat integration busy" }, 429);
    running++;
    try { await next(); } finally { running--; }
  });
  app.onError((error, c) => c.json({ error: error instanceof z.ZodError || error instanceof SyntaxError ? "invalid request" : "chat integration failed" }, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503));
  app.post("/request", async c => proxyChat(requestSchema.parse(await c.req.json()), deps, c.req.raw.signal));
  app.post("/review", async c => {
    const body = z.object({ content: z.string().max(24000), existingTitles: z.array(z.string().max(200)).max(100) }).strict().parse(await c.req.json());
    return c.json(await deps.review(body.content, body.existingTitles, c.req.raw.signal) as Record<string, unknown>);
  });
  return app;
}
