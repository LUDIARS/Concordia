import { Hono } from "hono";
import type { SessionsApiDeps } from "./deps.js";
import { registerLifecycleRoutes } from "./lifecycle.js";
import { registerEventsRoutes } from "./events.js";
import { registerQaRoutes } from "./qa.js";
import { registerRelayRoutes } from "./relay.js";
import { registerTitleGoalRoutes } from "./title-goal.js";
import { registerEndRoutes } from "./end.js";
import { registerSkillRoutes } from "./skills.js";
import { registerMessagesRoutes } from "./messages.js";

export type { SessionsApiDeps } from "./deps.js";

export function sessionsRouter(deps: SessionsApiDeps): Hono {
  const app = new Hono();
  registerLifecycleRoutes(app, deps);
  registerEventsRoutes(app, deps);
  registerQaRoutes(app, deps);
  registerRelayRoutes(app, deps);
  registerTitleGoalRoutes(app, deps);
  registerEndRoutes(app, deps);
  registerSkillRoutes(app, deps);
  registerMessagesRoutes(app, deps);
  return app;
}
