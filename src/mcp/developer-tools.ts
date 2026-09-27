import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolInput } from "../developer-tools/contracts.js";
import { DEVELOPER_TOOLS } from "../developer-tools/catalog.js";
import { ownWorktreeSession } from "./worktree-tools.js";

type Call = (method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown) =>
  Promise<{ ok: boolean; status: number; body: unknown }>;
function result(response: Awaited<ReturnType<Call>>) {
  return { ...(response.ok ? {} : { isError: true }), content: [{ type: "text" as const,
    text: JSON.stringify({ status: response.status, body: response.body,
      ...(!response.ok && response.status === 0 ? { next_action: "Outcome unknown. Reconcile the same request/target; do not blindly repeat a mutation." } : {}) }) }] };
}

export function registerDeveloperTools(server: McpServer, call: Call, ownSession = ownWorktreeSession): void {
  server.registerTool("concordia_tool_catalog", { description: "List Cc tools, effective entrypoints, prerequisites and API/CLI alternatives. Listing does not mean the client MCP is connected.",
    inputSchema: {}, annotations: { readOnlyHint: true } }, async () => result(await call("GET", "/v1/developer-tools/catalog")));
  for (const definition of DEVELOPER_TOOLS) {
    const schema = ToolInput.options.find(option => option.shape.operation.value === definition.operation)!;
    const shape: z.ZodRawShape = { ...schema.shape };
    delete shape.operation;
    server.registerTool(`concordia_${definition.operation}`, {
      description: `${definition.owner}: ${definition.operation}. ${definition.preparation}. Scope is the caller's active checkout. Missing preparation is returned with next_action; never automatically install/start services.`,
      inputSchema: shape,
      annotations: { readOnlyHint: definition.effect === "read", destructiveHint: false,
        idempotentHint: definition.effect !== "execute", openWorldHint: definition.transport !== "CLI" },
    }, async args => {
      try {
        const session_id = await ownSession();
        const input = schema.parse({ ...args, operation: definition.operation });
        return result(await call("POST", "/v1/developer-tools/execute", { session_id, input }));
      } catch { return { isError: true, content: [{ type: "text" as const, text: "Caller identity or tool input is invalid. Connect the current Lictor session and check the tool schema." }] }; }
    });
  }

  const text = z.string().trim().min(1).max(1_000);
  const routes = [
    { name: "switch_branch", path: "switch", shape: { project_code: text, branch: text, task: text }, description: "Switch this session to an existing owned branch worktree; returns cwd. Never switches a shared checkout or discards edits." },
    { name: "bind_work", path: "bind", shape: { cwd: text, task: text }, description: "Inspect Git and bind this session to its actual working checkout." },
    { name: "commit_work", path: "commit", shape: { message: text, paths: z.array(text).min(1).max(200) }, description: "Commit only the explicitly listed work paths through Cc's work submission guard." },
    { name: "submit_work", path: "submit", shape: {}, description: "Submit committed work through the repository's configured route; inspect existing submission on an unknown outcome." },
    { name: "control_service", path: "service", shape: { service_code: text, action: z.enum(["start", "stop", "restart"]), note: text.optional() }, description: "Explicitly authorized service control through Excubitor with Cc testing claim/release; operates on the catalog's main repository." },
  ];
  for (const route of routes) server.registerTool(`concordia_${route.name}`, {
    description: route.description, inputSchema: route.shape as z.ZodRawShape,
    annotations: { readOnlyHint: false, destructiveHint: route.path === "service", idempotentHint: false },
  }, async args => {
    try { return result(await call("POST", `/v1/implementation-tools/${route.path}`, { ...args, session_id: await ownSession() })); }
    catch { return { isError: true, content: [{ type: "text" as const, text: "Connect the current Lictor session before this operation." }] }; }
  });
  server.registerTool("concordia_check_bash", {
    description: "Check a Bash command with the authoritative Cc harness. This never executes the command and a pass grants no additional permission.",
    inputSchema: { command: z.string().min(1).max(20_000), cwd: text, branch: text },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async args => {
    try { return result(await call("POST", "/v1/harness/gate", { action: { ...args, tool: "Bash" }, session_id: await ownSession() })); }
    catch { return { isError: true, content: [{ type: "text" as const, text: "Bash check unavailable; do not treat an unavailable check as permission." }] }; }
  });
}
