import { Hono } from "hono";
import { z } from "zod";
import { handleServiceDeployment, type DeploymentDelivery, type DeploymentLedger, type DeploymentLookup } from "../deploy/service-deployed.js";

const EventSchema = z.object({ code: z.string().trim().min(1).max(32), previousHash: z.string().trim().min(7).max(128), currentHash: z.string().trim().min(7).max(128), version: z.string().trim().min(1).max(128), startedAt: z.string().datetime(), restartCount: z.number().int().min(0) }).strict();

export function serviceDeployedRouter(deps: {
  ledger: DeploymentLedger;
  lookup: DeploymentLookup;
  delivery: DeploymentDelivery;
  authorize: (header: string | undefined) => boolean;
  log?: { info: (detail: Record<string, unknown>, message: string) => void; warn: (detail: Record<string, unknown>, message: string) => void };
}): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    if (!deps.authorize(c.req.header("x-excubitor-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = EventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const outcome = await handleServiceDeployment({ event: parsed.data, ledger: deps.ledger, lookup: deps.lookup, delivery: deps.delivery });
    const detail = { code: parsed.data.code, currentHash: parsed.data.currentHash, delivered: outcome.delivered, failed: outcome.failed };
    if (outcome.failed.length > 0) deps.log?.warn(detail, "service.deployed delivery partially failed");
    else deps.log?.info(detail, "service.deployed delivery completed");
    return c.json(outcome, outcome.duplicate ? 200 : 202);
  });
  return app;
}
