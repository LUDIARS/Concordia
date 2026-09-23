/** @implements spec/feature/internal-agent-model-policy.md */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { DelegationRepo } from "../db/delegation-repo.js";
import { collectForumModelUsage } from "../delegation/forum-model-usage.js";
import { selectInternalAgent } from "../delegation/internal-agent-policy.js";
import { createChildLogger } from "../shared/logger.js";
const logger = createChildLogger("internal-agent-selection");

const Request = z.object({ prompt: z.string().trim().min(1).max(20000), description: z.string().max(1000).default("") });
/** Read-only selection: does not create a run or start a provider. */
export function internalAgentSelectionRouter(
  repo: Pick<DelegationRepo, "listTemplates">,
  collectUsage = collectForumModelUsage,
): Hono {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 65536 }));
  app.post("/", async (c) => {
    let value: unknown;
    try { value = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
    const parsed = Request.safeParse(value);
    if (!parsed.success) return c.json({ error: "invalid_task" }, 400);
    const usage = await collectUsage({ log: logger });
    const selection = selectInternalAgent({ title: parsed.data.description, body: parsed.data.prompt,
      templates: repo.listTemplates({ includeInactive: false }).map((row) => ({ ...row, is_active: row.is_active === 1 })),
      ...usage, nowSec: Math.floor(Date.now() / 1000) });
    if (!selection) return c.json({ error: "no_model_candidate" }, 503);
    return c.json({ selection });
  });
  return app;
}
