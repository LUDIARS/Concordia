/** @implements TB-MULTI — `lictor cli task set --repo` adds a checkout to the session's registrations. */
import type { Hono } from "hono";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { SessionsApiDeps } from "./deps.js";
import { readWorkingTargets, removeWorkingTarget, upsertWorkingTarget, WORKING_TARGETS_METADATA_KEY, type WorkingTarget } from "../../harness/reliability/working-targets.js";
import { nowSec } from "./runtime.js";

const RepoSchema = z.string().trim().min(1).max(1024).refine(isAbsolute, "repo must be an absolute path");

const WorkingTargetsSchema = z.object({
  add: z.object({ repo: RepoSchema, branch: z.string().trim().min(1).max(256) }).strict().optional(),
  remove: z.object({ repo: RepoSchema }).strict().optional(),
}).strict().refine(body => body.add || body.remove, "add or remove is required");

/** The registration the gate decides with, read back after the write (the caller sees what is stored). */
export function serializeRegistration(session: { repo_path: string; branch: string | null; target_project?: string | null; metadata: string | null }): {
  repo_path: string; branch: string | null; target_project: string | null; working_targets: WorkingTarget[];
} {
  return { repo_path: session.repo_path, branch: session.branch, target_project: session.target_project ?? null,
    working_targets: readWorkingTargets(session.metadata) };
}

export function registerWorkingTargetsRoutes(app: Hono, deps: Pick<SessionsApiDeps, "repo">): void {
  app.get("/:id/working-targets", (c) => {
    const session = deps.repo.findSession(c.req.param("id"));
    if (!session) return c.json({ error: "not_found" }, 404);
    return c.json(serializeRegistration(session));
  });

  app.patch("/:id/working-targets", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const parsed = WorkingTargetsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_working_targets", detail: parsed.error.flatten() }, 400);
    const { add, remove } = parsed.data;
    deps.repo.updateMetadata(id, (current) => {
      let list = readWorkingTargets(JSON.stringify(current));
      if (remove) list = removeWorkingTarget(list, remove.repo);
      if (add) list = upsertWorkingTarget(list, { repo: add.repo, branch: add.branch, source: "explicit", registered_at: nowSec() });
      return { ...current, [WORKING_TARGETS_METADATA_KEY]: list };
    });
    const stored = deps.repo.findSession(id);
    if (!stored) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true, registration: serializeRegistration(stored) });
  });
}
