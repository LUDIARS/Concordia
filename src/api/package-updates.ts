import { Hono } from "hono";
import { z } from "zod";
import { handlePackageUpdates, type PackageUpdateLedger } from "../deploy/package-updates.js";

const EventSchema = z.object({
  source: z.literal("ergo-watch"),
  runId: z.string().min(1).max(128),
  messages: z.array(z.object({ text: z.string().min(1).max(1900), private: z.boolean() }).strict()).min(1).max(20),
}).strict();

/** Excubitor (ergo-watch) のパッケージ更新お知らせを受ける (spec/feature/package-update-events.md)。 */
export function packageUpdatesRouter(deps: {
  ledger: PackageUpdateLedger;
  /** デプロイ通知チャンネルが設定されているか。 未設定なら台帳に触れず 503。 */
  configured: () => boolean;
  post: (content: string) => Promise<void>;
  authorize: (header: string | undefined) => boolean;
  log?: { info: (detail: Record<string, unknown>, message: string) => void; warn: (detail: Record<string, unknown>, message: string) => void };
}): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    if (!deps.authorize(c.req.header("x-excubitor-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = EventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    if (!deps.configured()) return c.json({ error: "not_configured" }, 503);
    const outcome = await handlePackageUpdates({ event: parsed.data, ledger: deps.ledger, post: deps.post });
    const detail = { runId: parsed.data.runId, messages: parsed.data.messages.length, delivered: outcome.delivered, failed: outcome.failed, duplicate: outcome.duplicate };
    if (outcome.failed.length > 0) deps.log?.warn(detail, "package-updates delivery partially failed");
    else deps.log?.info(detail, "package-updates delivery completed");
    return c.json(outcome, 202);
  });
  return app;
}
