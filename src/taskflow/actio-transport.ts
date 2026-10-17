import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import type { ActioAccess } from "./actio-binding.js";
import { z } from "zod";

const LocalTeams = z.object({ teams: z.array(z.object({ id: z.string(), role: z.string() })) });
/** How long a port resolved from the catalog may stand in when the catalog lookup itself fails. */
const LAST_PORT_TTL_MS = 5 * 60_000;

/** Authenticated, bounded Actio I/O. Never log response bodies or credentials. */
export class ActioTransport {
  constructor(
    private readonly catalog: Pick<ExcubitorClient, "findService">,
    private readonly token: (name: string) => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  private lastPort: { port: number; at: number } | null = null;

  async request(binding: ActioAccess, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> {
    const local = binding.authMode === "loopback";
    if (local && (binding.ownerId !== "actio-local"
      || binding.subsidiaryId !== null || binding.tokenEnv !== undefined)) {
      throw new Error("Invalid Actio authentication binding");
    }
    const token = binding.tokenEnv ? this.token(binding.tokenEnv)?.trim() : undefined;
    if (!local && !token) throw new Error("Actio task credential is required");
    const port = await this.resolvePort();
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
    if (local && binding.teamId !== null) {
      const teams = LocalTeams.safeParse(await this.send(base, token, "GET", "/api/teams"));
      if (!teams.success) throw new Error("Invalid Actio team list response");
      if (!teams.data.teams.some(team => team.id === binding.teamId && team.role === "leader")) {
        throw new Error("Actio task team access mismatch");
      }
    }
    return this.send(base, token, method, path, body);
  }

  /**
   * Resolves Actio's port through the Excubitor catalog. A catalog that cannot be
   * reached (slow or down) is not evidence that Actio stopped, so it is reported as
   * a lookup failure, and a port resolved shortly before is reused meanwhile.
   */
  private async resolvePort(): Promise<number> {
    let service: Awaited<ReturnType<ExcubitorClient["findService"]>>;
    try {
      service = await this.catalog.findService("actio", this.timeoutMs);
    } catch {
      if (this.lastPort && this.now() - this.lastPort.at <= LAST_PORT_TTL_MS) return this.lastPort.port;
      throw new Error("Actio service lookup failed");
    }
    // Historical process observations can retain an old port after a restart.
    // A declared catalog endpoint takes precedence and must itself be valid.
    const port = service?.catalog_snapshot?.port !== undefined
      ? resolveServicePort({ port: service.catalog_snapshot.port }) : resolveServicePort(service);
    if (!service || service.state !== "running" || port === null) {
      this.lastPort = null;
      throw new Error("Actio task service unavailable");
    }
    this.lastPort = { port, at: this.now() };
    return port;
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
