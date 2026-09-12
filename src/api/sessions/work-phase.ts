/** @implements CC-SESSION-WORK-PHASES — session-owned stage reporting endpoint. */
// @spec セッションの設計・開始確認・実装・調整
import type { Hono } from "hono";
import type { SessionsApiDeps } from "./deps.js";
import { eventBus } from "../../events.js";
import { readSessionWorkPhase, WorkPhaseConflict, WorkPhaseInvalid, WorkPhaseUpdateSchema } from "../../work/session-work-phase.js";
import { updateSessionWorkPhase } from "../../work/update-session-work-phase.js";
import { nowSec } from "./shared.js";

export function registerWorkPhaseRoutes(app: Hono, deps: Pick<SessionsApiDeps, "repo">): void {
  app.get("/:id/work-phase", (c) => {
    const session = deps.repo.findSession(c.req.param("id"));
    return session ? c.json({ work_phase: readSessionWorkPhase(session) }) : c.json({ error: "not_found" }, 404);
  });
  app.put("/:id/work-phase", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const parsed = WorkPhaseUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const ts = nowSec();
      const workPhase = updateSessionWorkPhase(deps.repo, id, parsed.data, ts);
      eventBus.emit({ type: "session.event", session_id: id, kind: "work_phase_changed", ts });
      return c.json({ work_phase: workPhase });
    } catch (error) {
      if (error instanceof WorkPhaseConflict) return c.json({ error: error.message }, 409);
      if (error instanceof WorkPhaseInvalid) return c.json({ error: error.message }, 400);
      throw error;
    }
  });
}
