/**
 * Hono app factory.
 */

import { Hono } from "hono";
import { registerChatRoutes, type ChatDeps } from "./api/register-chat.js";
import { registerCoreRoutes, type CoreDeps } from "./api/register-core.js";
import { registerCostRoutes, type CostDeps } from "./api/register-cost.js";
import { registerWebRoutes } from "./api/register-web.js";
import { makeDiscordChannelDirectory } from "./discord/channel-directory.js";
import { adminAuthMiddleware } from "./shared/admin-auth.js";
import { createChildLogger } from "./shared/logger.js";

export type AppDeps = Omit<CoreDeps, "channelDirectory"> & ChatDeps & CostDeps & {
  startedAt: string;
  chatRoutes?: ChatDeps | null;
  costRoutes?: CostDeps | null;
};

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();
  const requestLog = createChildLogger("http");

  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    const elapsedMs = Date.now() - started;
    if (c.req.path === "/health" || elapsedMs >= 1000) {
      const line = `request ${c.req.method} ${c.req.path} status=${c.res.status} duration_ms=${elapsedMs}`;
      if (elapsedMs >= 1000) requestLog.warn(line);
      else requestLog.info(line);
    }
  });

  const adminAuth = adminAuthMiddleware(() => deps.config.adminToken);
  app.use("/v1/admin/*", adminAuth);
  app.use("/v1/sweeper/run", adminAuth);

  app.get("/health", (c) =>
    c.json({ ok: true, service: "concordia", version: "0.1.0", started_at: deps.startedAt }),
  );

  registerCoreRoutes(app, {
    ...deps,
    channelDirectory: makeDiscordChannelDirectory({
      pendingQuestions: deps.pendingQuestions,
      sessionChannels: deps.discordChannels,
      config: deps.discordConfig,
    }),
  });
  if (deps.chatRoutes !== null) registerChatRoutes(app, deps.chatRoutes ?? deps);
  if (deps.costRoutes !== null) registerCostRoutes(app, deps.costRoutes ?? deps);
  registerWebRoutes(app);

  return app;
}
