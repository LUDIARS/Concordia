import { Hono, type Context } from "hono";
import { isIP } from "node:net";
import { z } from "zod";
import type { WebPushRepo } from "../db/web-push-repo.js";
import type { WebPushService } from "../push/service.js";

const HttpsEndpointSchema = z.string().max(2048).url().refine(
  (value) => {
    try {
      const endpoint = new URL(value);
      const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
      const lowerHostname = hostname.toLowerCase();
      return endpoint.protocol === "https:"
        && endpoint.username === ""
        && endpoint.password === ""
        && endpoint.port === ""
        && endpoint.hash === ""
        && hostname.includes(".")
        && isIP(hostname) === 0
        && lowerHostname !== "localhost"
        && !lowerHostname.endsWith(".localhost")
        && !lowerHostname.endsWith(".local")
        && !lowerHostname.endsWith(".internal")
        && !lowerHostname.endsWith(".home.arpa");
    } catch {
      return false;
    }
  },
  "subscription endpoint must be a public HTTPS origin on the default port",
);

const SubscriptionKeySchema = z.string().min(8).max(512).regex(/^[A-Za-z0-9_-]+={0,2}$/, "subscription key must be base64url");

const SubscriptionSchema = z.object({
  client_id: z.string().min(1).max(128),
  subscription: z.object({
    endpoint: HttpsEndpointSchema,
    keys: z.object({ p256dh: SubscriptionKeySchema, auth: SubscriptionKeySchema }),
  }),
});

const DeleteSubscriptionSchema = z.object({
  client_id: z.string().min(1).max(128),
  endpoint: HttpsEndpointSchema,
});

/** @implements spec/feature/session-message-webui-chat.md §1.4 */
export function pushRouter(deps: { repo: WebPushRepo; service: WebPushService }): Hono {
  const app = new Hono();
  app.get("/vapid-public-key", (c) => c.json({ public_key: deps.service.getPublicKey() }));
  app.post("/subscriptions", async (c) => {
    const rejected = rejectUnsafeSubscriptionMutation(c);
    if (rejected) return rejected;
    const parsed = SubscriptionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    deps.repo.upsert({ client_id: parsed.data.client_id, endpoint: parsed.data.subscription.endpoint, ...parsed.data.subscription.keys }, Math.floor(Date.now() / 1000));
    return c.json({ ok: true });
  });
  app.delete("/subscriptions", async (c) => {
    const rejected = rejectUnsafeSubscriptionMutation(c);
    if (rejected) return rejected;
    const parsed = DeleteSubscriptionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    deps.repo.delete(parsed.data.endpoint, parsed.data.client_id);
    return c.json({ ok: true });
  });
  return app;
}

/** @implements spec/feature/session-message-webui-chat.md §1.4 credential boundary */
function rejectUnsafeSubscriptionMutation(c: Context): Response | null {
  const mediaType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    // Requiring a non-simple content type forces cross-origin browsers through CORS preflight.
    return c.json({ error: "application/json required" }, 415);
  }
  const fetchSite = c.req.header("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    return c.json({ error: "cross-origin subscription changes are forbidden" }, 403);
  }
  return null;
}
