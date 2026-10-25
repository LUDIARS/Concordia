import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { OrbisError, publicOrbisError } from "../orbis/errors.js";
import { ORBIS_OPERATIONS, OrbisClientId, OrbisInputs } from "../orbis/request.js";
import type { OrbisService } from "../orbis/service.js";

export function orbisRouter(service: OrbisService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use("*", bodyLimit({ maxSize: 32_000, onError: c => c.json({ error: "orbis_invalid_request" }, 413) }));
  app.onError((error, c) => {
    const code = publicOrbisError(error);
    const status = code === "orbis_invalid_request" ? 400 : code === "orbis_unavailable" ? 503
      : code === "orbis_unauthorized" || code === "orbis_reveal_requires_user_utterance" ? 403 : 409;
    return c.json({ error: code }, status);
  });
  for (const operation of ORBIS_OPERATIONS) {
    app.post(`/${operation}`, async c => {
      const parsed = OrbisInputs[operation].extend({ session_id: OrbisClientId }).strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new OrbisError("orbis_invalid_request");
      const { session_id, ...args } = parsed.data;
      return c.json(await service.execute(session_id, operation, args));
    });
  }
  return app;
}
