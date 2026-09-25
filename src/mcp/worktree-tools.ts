import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type WorktreeCall = (method: "POST", path: string, body: unknown) =>
  Promise<{ ok: boolean; status: number; body: unknown }>;

/** The sidecar identifies the caller; tool arguments cannot select another session. */
export async function ownWorktreeSession(
  port = process.env.LICTOR_PORT, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("Lictor sidecar is unavailable");
  }
  const response = await fetchImpl(`http://127.0.0.1:${port}/v1/concordia/session`, {
    redirect: "error", signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Lictor session lookup failed");
  return z.object({ session_id: z.string().trim().min(1) }).parse(await response.json()).session_id;
}

export function registerWorktreeTools(
  server: McpServer, call: WorktreeCall, ownSession: () => Promise<string> = ownWorktreeSession,
): void {
  server.registerTool("concordia_create_worktree", {
    description: "Create a task worktree from the registered repository's local main, resolve its Actio project, save ignored worktree metadata, and bind this Lictor session. Requires an instruction to work on the project. Returns cwd: use it for subsequent editing. On an unknown outcome retry the same project and branch; never allocate a replacement branch. Does not start services or run tests.",
    inputSchema: {
      project_code: z.string().trim().min(1).max(64),
      branch: z.string().trim().min(1).max(200),
      task: z.string().trim().min(1).max(1_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ project_code, branch, task }) => {
    let sessionId: string;
    try { sessionId = await ownSession(); }
    catch {
      return { isError: true, content: [{ type: "text" as const,
        text: "The caller's Lictor session could not be identified. No worktree was requested." }] };
    }
    const response = await call("POST", "/v1/implementation-tools/worktree", {
      session_id: sessionId, project_code, branch, task,
    });
    return { ...(response.ok ? {} : { isError: true }), content: [{ type: "text" as const,
      text: JSON.stringify({ status: response.status, body: response.body,
        ...(!response.ok && response.status === 0 ? {
          guidance: "Outcome unknown. Retry this same project and branch to reconcile the owned worktree.",
        } : {}),
      }) }] };
  });
}
