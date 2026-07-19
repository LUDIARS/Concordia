import { z } from "zod";
import type { Hono } from "hono";
import { eventBus, fetchFromLictor, resolveLictorTarget, nowSec } from "./runtime.js";
import type { SessionsApiDeps } from "./deps.js";
import {
  listSessionSkillSources,
  loadSessionSkill,
  readWorkingBranch,
} from "../../control/session-skill-source.js";

const SkillSchema = z.object({ name: z.string().min(1).max(64) });

export function registerSkillRoutes(app: Hono, deps: SessionsApiDeps): void {
  app.get("/:id/skills", async (c) => {
    const session = deps.repo.findSession(c.req.param("id"));
    if (!session) return c.json({ error: "not_found" }, 404);
    const branch = await syncWorkingBranch(deps, session.id, session.repo_path, session.branch);
    const requestedBranch = readRequestedBranch(session.metadata);
    const skills = await listSessionSkillSources(session.repo_path).catch(() => []);
    return c.json({
      ok: true,
      branch,
      requested_branch: requestedBranch,
      branch_mismatch: Boolean(requestedBranch && branch !== requestedBranch),
      repo_path: session.repo_path,
      skills,
    });
  });

  app.post("/:id/skill", async (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const parsed = SkillSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const branch = await syncWorkingBranch(deps, id, session.repo_path, session.branch);
    const requestedBranch = readRequestedBranch(session.metadata);
    if (requestedBranch && branch !== requestedBranch) {
      return c.json(
        { error: `branch mismatch: requested ${requestedBranch}, actual ${branch ?? "(detached)"}` },
        409,
      );
    }
    const skill = await loadSessionSkill(session.repo_path, parsed.data.name).catch(
      (error: Error) => ({ error: error.message }),
    );
    if (!skill) return c.json({ error: `skill not found in current worktree: ${parsed.data.name}` }, 404);
    if ("error" in skill) return c.json({ error: skill.error }, 400);

    const target = resolveLictorTarget(deps.repo, id);
    if ("error" in target) return c.json({ error: target.error }, 409);
    let sidecarLoaded = false;
    let sidecarWarning: string | null = null;
    try {
      const upstream = await fetchFromLictor(target.port, "/v1/skill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: skill.name, content: skill.content }),
      });
      const body = await upstream.json().catch(() => ({})) as Record<string, unknown>;
      sidecarLoaded = upstream.ok;
      if (!upstream.ok) sidecarWarning = String(body.error ?? `HTTP ${upstream.status}`);
    } catch (error) {
      sidecarWarning = `lictor skill store unavailable: ${(error as Error).message}`;
    }
    const ts = nowSec();
    const invocation = [
      `【Cc /cc-skill】現在の作業ブランチ \`${branch ?? "(detached)"}\` から skill \`${skill.name}\` を呼び出します。`,
      `source: ${skill.relativePath}`,
      "以下の SKILL.md をこの依頼の手順として適用してください。",
      "",
      skill.content,
    ].join("\n");
    deps.repo.appendEvent({
      session_id: id,
      ts,
      kind: "skill_invoked",
      payload: {
        name: skill.name,
        source: skill.relativePath,
        branch,
        sidecar_loaded: sidecarLoaded,
        sidecar_warning: sidecarWarning,
      },
    });
    eventBus.emit({
      type: "session.inject",
      target_session_id: id,
      text: invocation,
      source: "discord:cc-skill",
      ts,
    });
    return c.json({
      ok: true,
      name: skill.name,
      source: skill.relativePath,
      branch,
      repo_path: session.repo_path,
      sidecar_loaded: sidecarLoaded,
      sidecar_warning: sidecarWarning,
    });
  });
}

function readRequestedBranch(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const value = (JSON.parse(metadata) as { requested_branch?: unknown }).requested_branch;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

async function syncWorkingBranch(
  deps: SessionsApiDeps,
  sessionId: string,
  repoPath: string,
  registeredBranch: string | null,
): Promise<string | null> {
  const actual = await readWorkingBranch(repoPath);
  if (!actual || actual === registeredBranch) return actual ?? registeredBranch;
  deps.repo.patchSession(sessionId, { branch: actual });
  const ts = nowSec();
  deps.repo.appendEvent({
    session_id: sessionId,
    ts,
    kind: "branch_registered",
    payload: { branch: actual, previous_branch: registeredBranch, source: "cc-skill" },
  });
  eventBus.emit({ type: "session.event", session_id: sessionId, kind: "branch_changed", ts });
  return actual;
}
