import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AwsAttempt, AwsRequestSchema } from "../cloud-work/aws-request.js";

type Call = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ ok: boolean; status: number; body: unknown }>;
const Command = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("targets") }).strict(),
  z.object({ operation: z.literal("start"), request: AwsRequestSchema }).strict(),
  z.object({ operation: z.literal("status"), attemptId: AwsAttempt.optional() }).strict(),
  z.object({ operation: z.literal("stop"), attemptId: AwsAttempt }).strict(),
]);

export function executeCloudAwsTool(command: unknown, sessionId: string | undefined, call: Call): ReturnType<Call> {
  if (!sessionId?.trim()) throw new Error("cloud_active_session_required");
  const input = Command.parse(command);
  const base = "/v1/delegation/cloud/aws", query = `session_id=${encodeURIComponent(sessionId)}`;
  if (input.operation === "targets") return call("GET", `${base}/targets?${query}`);
  if (input.operation === "status") return call("GET", `${base}/runs${input.attemptId ? "/" + input.attemptId : ""}?${query}`);
  if (input.operation === "stop") return call("POST", `${base}/runs/${input.attemptId}/stop`, { session_id: sessionId });
  return call("POST", `${base}/proposals`, { ...input.request, session_id: sessionId });
}

export function registerCloudAwsTools(server: McpServer, call: Call, sessionId: () => string | undefined): void {
  server.registerTool("delegation_cloud_aws", {
    description: "List registered EC2/Fargate targets, request a start for human approval in the Delegation WebUI, inspect the original attempt or request its stop. Use only public code, non-confidential inputs and the listed destination. Keep the same attemptId after timeout.",
    inputSchema: { command: Command },
  }, async ({ command }) => {
    try {
      const result = await executeCloudAwsTool(command, sessionId(), call);
      return { isError: !result.ok, content: [{ type: "text" as const, text: JSON.stringify(result.body) }] };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "AWS cloud request unavailable or invalid." }] };
    }
  });
}
