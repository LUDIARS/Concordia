import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OrbisEndpoint } from "./endpoint.js";
import type { OrbisRequest } from "./request.js";
import { OrbisError } from "./errors.js";

export interface OrbisConnection extends OrbisEndpoint { token: string; clientId: string }

/** One invocation owns its client, transport and deadline. Never retry an uncertain browser action. */
export async function callOrbisTool(request: OrbisRequest, connection: OrbisConnection,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<CallToolResult> {
  const timeoutMs = options.timeoutMs ?? (request.operation === "read" && request.mode === "screenshot" ? 30_000 : 15_000);
  const abort = new AbortController();
  let unauthorized = false, connected = false;
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}`,
      "x-orbis-client-id": connection.clientId, "x-orbis-instance-id": connection.instanceId } },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, init) => {
      const signal = init?.signal ? AbortSignal.any([abort.signal, init.signal]) : abort.signal;
      const response = await (options.fetchImpl ?? fetch)(url, { ...init, signal, redirect: "error" });
      if (response.status === 401 || response.status === 403) {
        unauthorized = true;
        // Do not let the SDK attempt OAuth discovery or include the response body in an exception.
        throw new OrbisError("orbis_unauthorized");
      }
      return response;
    },
  });
  const client = new Client({ name: "concordia-orbis", version: "1.0.0" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new OrbisError("orbis_unavailable")); }, timeoutMs);
    });
    const work = async (): Promise<CallToolResult> => {
      await client.connect(transport, { signal: abort.signal, timeout: timeoutMs });
      connected = true;
      const { operation, ...args } = request;
      const result = await client.callTool({ name: `orbis_${operation}`, arguments: args }, undefined,
        { signal: abort.signal, timeout: timeoutMs });
      if (result.isError) throw new OrbisError("orbis_operation_failed");
      return result as CallToolResult;
    };
    return await Promise.race([work(), deadline]);
  } catch (error) {
    if (unauthorized) throw new OrbisError("orbis_unauthorized");
    if (error instanceof OrbisError) throw error;
    throw new OrbisError(!connected || abort.signal.aborted || error instanceof TypeError ? "orbis_unavailable" : "orbis_operation_failed");
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    // A disconnected peer can reject close; cleanup is best-effort and must not expose its raw error.
    await Promise.allSettled([client.close(), transport.close()]);
  }
}
