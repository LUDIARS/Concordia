import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ORBIS_OPERATIONS, OrbisClientId, OrbisInputs, parseOrbisRequest, type OrbisOperation } from "../orbis/request.js";
import { OrbisError, ORBIS_ERRORS, publicOrbisError } from "../orbis/errors.js";

type Call = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ ok: boolean; status: number; body: unknown }>;

/** The wrapper supplies identity; tool arguments can never override session_id or client headers. */
export async function executeOrbisTool(operation: OrbisOperation, input: unknown, sessionId: string | undefined, call: Call): Promise<unknown> {
  if (!sessionId || !OrbisClientId.safeParse(sessionId).success) throw new OrbisError("orbis_unauthorized");
  const { operation: _operation, ...args } = parseOrbisRequest(operation, input);
  const result = await call("POST", `/v1/orbis/${operation}`, { ...args, session_id: sessionId });
  if (!result.ok) {
    const code = (result.body as { error?: unknown } | null)?.error;
    throw new OrbisError(ORBIS_ERRORS.find(item => item === code) ?? "orbis_operation_failed");
  }
  return result.body;
}

export function registerOrbisTools(server: McpServer, call: Call, sessionId: () => string | undefined): void {
  for (const operation of ORBIS_OPERATIONS) {
    server.registerTool(`orbis_${operation}`, {
      description: operation === "reveal" ? "Reveal requires a verified human utterance; currently refused."
        : "Use only a sigillum the human provided from Orbis. Attach first. Never guess or enumerate sigilla. On timeout inspect state before retrying an action.",
      inputSchema: OrbisInputs[operation].shape,
    }, async (input: unknown) => {
      try {
        const output = await executeOrbisTool(operation, input, sessionId(), call);
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: publicOrbisError(error) }] };
      }
    });
  }
}
