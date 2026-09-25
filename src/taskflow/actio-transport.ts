import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import type { ActioAccess } from "./actio-binding.js";

/** Authenticated, bounded Actio I/O. Never log response bodies or credentials. */
export class ActioTransport {
  constructor(
    private readonly catalog: Pick<ExcubitorClient, "findService">,
    private readonly token: (name: string) => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async request(binding: ActioAccess, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> {
    const local = binding.authMode === "loopback";
    if (local && (binding.ownerId !== "actio-local" || binding.teamId !== null
      || binding.subsidiaryId !== null || binding.tokenEnv !== undefined)) {
      throw new Error("Invalid Actio authentication binding");
    }
    const token = binding.tokenEnv ? this.token(binding.tokenEnv)?.trim() : undefined;
    if (!local && !token) throw new Error("Actio task credential is required");
    const service = await this.catalog.findService("actio", this.timeoutMs);
    // Historical process observations can retain an old port after a restart.
    // A declared catalog endpoint takes precedence and must itself be valid.
    const port = service?.catalog_snapshot?.port !== undefined
      ? resolveServicePort({ port: service.catalog_snapshot.port }) : resolveServicePort(service);
    if (!service || service.state !== "running" || port === null) throw new Error("Actio task service unavailable");
    const base = `http://127.0.0.1:${port}`;
    // Actio's userContext can treat an invalid token as anonymous. Verify the
    // actual identity before every operation, including task creation.
    const identity = await this.send(base, token, "GET", "/api/auth/me");
    if (!identity || typeof identity !== "object" || !("id" in identity) || identity.id !== binding.ownerId) {
      throw new Error("Actio task identity mismatch");
    }
    const localIdentity = "localMode" in identity && identity.localMode === true;
    if (local ? !localIdentity || !("access" in identity) || identity.access !== "loopback" : localIdentity) {
      throw new Error("Actio task authentication mode mismatch");
    }
    return this.send(base, token, method, path, body);
  }

  private async send(base: string, token: string | undefined, method: string, path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${base}${path}`, {
        method, redirect: "error", signal: controller.signal,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Actio task request rejected (${response.status})`);
      }
      return await response.json() as unknown;
    } catch (error) {
      if (error instanceof Error && /^Actio task request rejected \(\d+\)$/.test(error.message)) throw error;
      // POST/PATCH may have committed: callers must retry with the same source identity.
      throw new Error("Actio task request outcome unknown; reconcile using the same task identity");
    } finally {
      clearTimeout(timer);
    }
  }
}
