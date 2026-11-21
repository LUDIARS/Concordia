import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ConfluxRequests } from "../conflux/requests.js";
import { parseConfluxSelection } from "../harness/reliability/conflux-policy.js";
import { isPublicRequest } from "../web-sso/policy.js";

const key = z.string().min(1).max(256);
const text = (max: number) => z.string().min(1).max(max);
const segment = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const spawnRequest = z.object({
  idempotency_key: key,
  project_code: segment,
  destination: z.object({ kind: z.enum(["subsidiary", "discord", "slack"]), address: z.record(text(256)) }).strict(),
  selection: z.unknown(),
  title: text(240),
  brief: text(16_000),
  requested_by: text(256),
  source_comments: z.array(z.object({ id: key, author: text(256), body: text(16_000) }).strict()).max(100),
}).strict();
const buildRequest = z.object({
  dedupe_key: key,
  project_code: segment,
  tide: segment,
  variant: segment,
  commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  branch: text(200).optional(),
  platforms: z.array(text(100)).max(32),
}).strict();

export function confluxRouter(deps: {
  requests: Pick<ConfluxRequests, "spawn" | "lookup" | "build">;
  identity: (token: string) => { actor_id: string; roles: string[] } | null;
  publicHost?: string;
  isLocalPeer?: (env: unknown) => boolean;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    const host = c.req.header("host")?.toLowerCase() ?? "";
    if (isPublicRequest(deps.publicHost ?? "\0", (name) => c.req.header(name))
      || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)
      || !deps.isLocalPeer?.(c.env)) return c.json({ error: "local_only" }, 403);
    await next();
  });
  const limit = bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "body_too_large" }, 413) });
  app.post("/spawn", limit, async (c) => {
    const parsed = spawnRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_spawn_request" }, 400);
    const selection = parseConfluxSelection(parsed.data.selection);
    if (!selection || selection.projectCode !== parsed.data.project_code) return c.json({ error: "invalid_selection" }, 400);
    const result = await deps.requests.spawn({ ...parsed.data, selection });
    return "error" in result ? c.json({ error: result.error }, result.status) : c.json(result, 200);
  });
  app.get("/spawn", (c) => {
    const parsed = key.safeParse(c.req.query("idempotency_key"));
    if (!parsed.success) return c.json({ error: "invalid_idempotency_key" }, 400);
    const result = deps.requests.lookup(parsed.data);
    return "error" in result ? c.json({ error: result.error }, result.status) : c.json(result);
  });
  app.post("/build", limit, async (c) => {
    const parsed = buildRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_build_request" }, 400);
    const result = deps.requests.build(parsed.data);
    return "error" in result ? c.json({ error: result.error }, result.status) : c.json(result, 202);
  });
  app.get("/identity", (c) => {
    const token = /^Bearer ([^\s,]{1,512})$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const identity = token && deps.identity(token);
    return identity ? c.json(identity) : c.json({ error: "unauthenticated" }, 401);
  });
  return app;
}

export function isConfluxLocalPeer(env: unknown): boolean {
  type Bindings = { incoming?: { socket?: { remoteAddress?: string } } };
  const options = env as (Bindings & { server?: Bindings }) | undefined;
  const address = (options?.server ?? options)?.incoming?.socket?.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
