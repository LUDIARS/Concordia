import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloudWorkPlanSchema } from "../cloud-work/runtime-config.js";

type Call = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ ok: boolean; status: number; body: unknown }>;
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const BatchId = z.string().regex(/^[A-Za-z0-9_-]{1,90}$/);
const Command = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("targets") }).strict(),
  z.object({ operation: z.literal("status"), attemptId: Id.optional() }).strict(),
  z.object({ operation: z.literal("collect"), attemptId: Id }).strict(),
  z.object({ operation: z.literal("reconcile"), attemptId: Id }).strict(),
  z.object({ operation: z.literal("observe"), attemptId: Id }).strict(),
  z.object({ operation: z.literal("batch_list"), limit: z.number().int().min(1).max(50).optional() }).strict(),
  z.object({ operation: z.literal("batch_status"), batchId: BatchId }).strict(),
  z.object({ operation: z.literal("batch_stop"), batchId: BatchId }).strict(),
  z.object({ operation: z.literal("submit"), attemptId: Id, targetId: Id,
    taskReference: z.string().regex(/^actio:[A-Za-z0-9-]+$/), instruction: z.string().min(1).max(12_000),
    computeReason: z.string().min(1).max(1000), llmReason: z.string().min(1).max(1000), gpuRequired: z.boolean(), work: CloudWorkPlanSchema.optional() }).strict(),
]);

/** Session identity is inherited from the wrapper, not selectable by a cloud worker. */
export async function executeCloudTool(command: unknown, sessionId: string | undefined, call: Call): Promise<unknown> {
  if (!sessionId?.trim()) throw new Error("cloud_active_session_required");
  const input = Command.parse(command), query = `session_id=${encodeURIComponent(sessionId)}`;
  const base = "/v1/delegation/cloud";
  if (input.operation === "targets") return call("GET", `${base}/targets?${query}`);
  if (input.operation === "status") return call("GET", `${base}/runs${input.attemptId ? `/${input.attemptId}` : ""}?${query}`);
  if (input.operation === "collect" || input.operation === "reconcile" || input.operation === "observe") {
    return call("POST", `${base}/runs/${input.attemptId}/${input.operation}`, { session_id: sessionId });
  }
  if (input.operation === "batch_list") {
    return call("GET", `${base}/batches?${query}${input.limit === undefined ? "" : `&limit=${input.limit}`}`);
  }
  if (input.operation === "batch_status") return call("GET", `${base}/batches/${input.batchId}?${query}`);
  if (input.operation === "batch_stop") return call("POST", `${base}/batches/${input.batchId}/stop`, { session_id: sessionId });
  const { operation: _operation, ...body } = input;
  return call("POST", `${base}/runs`, { ...body, session_id: sessionId });
}

export function registerCloudWorkTools(server: McpServer, call: Call, sessionId: () => string | undefined): void {
  server.registerTool("delegation_cloud_work", {
    description: "Use configured standard Codex/Claude clouds only when all four workload conditions hold. Query targets first. Submit with a stable attemptId; on timeout inspect that same ID, never create another. Collect verifies bytes, not task acceptance. Codex batch_list, batch_status and batch_stop are available; batch_stop stops new dispatch. Owner-attended Colab uses the authenticated WebUI.",
    inputSchema: { command: Command },
  }, async ({ command }) => {
    try {
      const result = await executeCloudTool(command, sessionId(), call) as Awaited<ReturnType<Call>>;
      return { isError: !result.ok, content: [{ type: "text" as const, text: JSON.stringify(result.body) }] };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "Cloud request unavailable or invalid; inspect the same attempt ID before any new submission." }] };
    }
  });
}
