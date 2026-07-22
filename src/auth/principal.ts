import type { Context, MiddlewareHandler } from "hono";
import { extractBearer, tokensMatch } from "../shared/admin-auth.js";

export type ConcordiaRole = "anonymous" | "viewer" | "operator" | "admin";

export type ConcordiaCapability =
  | "read"
  | "chat:write"
  | "session:control"
  | "process:control"
  | "release:confirm"
  | "admin:write";

export interface Principal {
  id: string;
  role: ConcordiaRole;
  capabilities: ReadonlySet<ConcordiaCapability>;
  authenticated: boolean;
}

export interface PrincipalCredential {
  id: string;
  role: Exclude<ConcordiaRole, "anonymous">;
  token: string;
}

declare module "hono" {
  interface ContextVariableMap {
    concordiaPrincipal: Principal;
  }
}

const ROLE_CAPABILITIES: Readonly<Record<ConcordiaRole, readonly ConcordiaCapability[]>> = {
  anonymous: ["read"],
  viewer: ["read"],
  operator: ["read", "chat:write", "session:control", "process:control", "release:confirm"],
  admin: ["read", "chat:write", "session:control", "process:control", "release:confirm", "admin:write"],
};

export function principal(id: string, role: ConcordiaRole, authenticated: boolean): Principal {
  return { id, role, authenticated, capabilities: new Set(ROLE_CAPABILITIES[role]) };
}

export const ANONYMOUS_PRINCIPAL = principal("anonymous", "anonymous", false);

export function authenticatePrincipal(
  headers: (name: string) => string | undefined,
  adminToken: string,
  credentialJson = process.env.CONCORDIA_PRINCIPAL_TOKENS ?? "",
): Principal {
  const supplied =
    extractBearer(headers("authorization")) ||
    (headers("x-concordia-admin-token") ?? "").trim();
  for (const credential of parsePrincipalCredentials(credentialJson)) {
    if (tokensMatch(credential.token, supplied)) {
      return principal(credential.id, credential.role, true);
    }
  }
  const expected = adminToken.trim();
  if (expected && tokensMatch(expected, supplied)) {
    return principal("admin", "admin", true);
  }
  return ANONYMOUS_PRINCIPAL;
}

export function parsePrincipalCredentials(raw: string): PrincipalCredential[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seenIds = new Set<string>();
    const seenTokens = new Set<string>();
    const credentials: PrincipalCredential[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id.trim() : "";
      const token = typeof value.token === "string" ? value.token.trim() : "";
      const role = value.role;
      if (
        !/^[a-zA-Z0-9_.:@/-]{1,120}$/.test(id) ||
        token.length < 16 ||
        (role !== "viewer" && role !== "operator" && role !== "admin") ||
        seenIds.has(id) ||
        seenTokens.has(token)
      ) return [];
      seenIds.add(id);
      seenTokens.add(token);
      credentials.push({ id, token, role });
    }
    return credentials;
  } catch {
    return [];
  }
}

export function principalMiddleware(getAdminToken: () => string): MiddlewareHandler {
  return async (c, next) => {
    c.set(
      "concordiaPrincipal",
      authenticatePrincipal((name) => c.req.header(name), getAdminToken() ?? ""),
    );
    await next();
  };
}

export function currentPrincipal(c: Context): Principal {
  return c.get("concordiaPrincipal") ?? ANONYMOUS_PRINCIPAL;
}

export function requireCapability(capability: ConcordiaCapability): MiddlewareHandler {
  return async (c, next) => {
    const actor = currentPrincipal(c);
    if (!actor.capabilities.has(capability)) {
      const status = actor.authenticated ? 403 : 401;
      return c.json(
        {
          error: actor.authenticated ? "forbidden" : "unauthorized",
          required_capability: capability,
        },
        status,
        status === 401 ? { "www-authenticate": 'Bearer realm="concordia"' } : undefined,
      );
    }
    await next();
  };
}
