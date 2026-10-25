import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { authorizeOrbisRequest } from "./authorization.js";
import type { OrbisEndpoint } from "./endpoint.js";
import { OrbisError } from "./errors.js";
import { callOrbisTool, type OrbisConnection } from "./mcp-client.js";
import { OrbisClientId, parseOrbisRequest, type OrbisOperation, type OrbisRequest } from "./request.js";

export interface OrbisService {
  execute(sessionId: string, operation: OrbisOperation, input: unknown): Promise<CallToolResult>;
}

export function createOrbisService(deps: {
  findSession: (id: string) => { status: string } | null | undefined;
  token: () => string | undefined;
  discover: () => Promise<OrbisEndpoint>;
  call?: (request: OrbisRequest, connection: OrbisConnection) => Promise<CallToolResult>;
}): OrbisService {
  return {
    async execute(sessionId, operation, input) {
      if (!OrbisClientId.safeParse(sessionId).success) throw new OrbisError("orbis_invalid_request");
      const request = parseOrbisRequest(operation, input);
      const authorize = (): void => {
        const denied = authorizeOrbisRequest(deps.findSession(sessionId), operation);
        if (denied) throw new OrbisError(denied);
      };
      authorize();
      const token = deps.token();
      if (!token) throw new OrbisError("orbis_token_missing");
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new OrbisError("orbis_unauthorized");
      const endpoint = await deps.discover();
      // Discovery is asynchronous: do not start a new browser operation after session ownership ends.
      authorize();
      return (deps.call ?? callOrbisTool)(request, { ...endpoint, token, clientId: sessionId });
    },
  };
}
