/**
 * リポ担当の一覧と手動依頼 (spec/feature/session-auto-succession.md §3.6, §3.1 02c)。
 *
 * - GET  /:id/repo-agents — 親の担当一覧 (checkout / project_code / 状態 / 子 session id / 子の現 status / 契機)。
 *   子の session id を渡すと、 子の `repo_agent_of` (親) も返す。
 * - POST /:id/repo-agents — body `{ text }` の repo-brief ブロックを親の依頼として受け付ける。
 */

import type { Hono } from "hono";
import { z } from "zod";
import { parseSessionMetadata } from "../../control/succession/managed-session.js";
import { readRepoAgentOf } from "../../control/succession/repo-agents-state.js";
import type { SessionsApiDeps } from "./deps.js";

const SubmitSchema = z.object({ text: z.string().min(1).max(64_000) });

export function registerRepoAgentRoutes(app: Hono, deps: SessionsApiDeps): void {
  app.get("/:id/repo-agents", (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const rows = deps.repoAgents?.list(id) ?? [];
    return c.json({
      session_id: id,
      repo_agent_of: readRepoAgentOf(parseSessionMetadata(session.metadata)),
      agents: rows.map((row) => ({
        ...row,
        child_status: row.child_session_id ? deps.repo.findSession(row.child_session_id)?.status ?? null : null,
      })),
    });
  });

  app.post("/:id/repo-agents", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    if (!deps.repoAgents) return c.json({ error: "repo_agents_unavailable" }, 503);
    const parsed = SubmitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const result = await deps.repoAgents.submitBriefs(id, parsed.data.text);
    return c.json({ ok: true, ...result });
  });
}
