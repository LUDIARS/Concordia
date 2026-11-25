import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import type { ActioAccess } from "./actio-binding.js";
import { z } from "zod";
import { actingForHeaders } from "./actio-acting-for.js";
import { classifyActioRequestFailure } from "./actio-request-failure.js";

const LocalTeams = z.object({ teams: z.array(z.object({ id: z.string(), role: z.string() })) });
/** How long a port resolved from the catalog may stand in when the catalog lookup itself fails. */
const LAST_PORT_TTL_MS = 5 * 60_000;
/** Upper bound for the liveness probe used when the catalog state disagrees. */
const LIVENESS_TIMEOUT_MS = 3_000;

/** Authenticated, bounded Actio I/O. Never log response bodies or credentials. */
export class ActioTransport {
  constructor(
    private readonly catalog: Pick<ExcubitorClient, "findService">,
    private readonly token: (name: string) => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly now: () => number = Date.now,
    /** Records catalog state disagreements (state value and port only; never bodies or credentials). */
    private readonly log: (message: string) => void = (message) => console.warn(message),
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
    // Only the local owner speaks for a human; Actio trusts the header from loopback only.
    const extra = local && method !== "GET" ? actingForHeaders() : {};
    return this.send(base, token, method, path, body, extra);
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
      // Excubitor's state can lag or flap while Actio keeps serving (2026-11-17: Actio
      // answered directly while the catalog said otherwise, failing delegation sealing).
      // Actio's own liveness decides; the catalog state is only logged.
      const live = await this.liveFallbackPort([port, this.recentPort()]);
      const state = service ? String(service.state) : "missing";
      if (live !== null) {
        this.log(`actio-transport: catalog state=${state} port=${port ?? "none"}; /api/health/live answered on ${live}, using it`);
        this.lastPort = { port: live, at: this.now() };
        return live;
      }
      this.log(`actio-transport: catalog state=${state} port=${port ?? "none"}; no live Actio endpoint`);
      this.lastPort = null;
      throw new Error("Actio task service unavailable");
    }
    this.lastPort = { port, at: this.now() };
    return port;
  }

  private recentPort(): number | null {
    return this.lastPort && this.now() - this.lastPort.at <= LAST_PORT_TTL_MS ? this.lastPort.port : null;
  }

  /** The first candidate whose /api/health/live identifies itself as Actio. */
  private async liveFallbackPort(candidates: ReadonlyArray<number | null>): Promise<number | null> {
    for (const port of new Set(candidates.filter((value): value is number => value !== null))) {
      if (await this.isLive(port)) return port;
    }
    return null;
  }

  private async isLive(port: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, LIVENESS_TIMEOUT_MS));
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/api/health/live`, {
        method: "GET", redirect: "error", signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      const body = await response.json() as unknown;
      return !!body && typeof body === "object" && "service" in body && body.service === "actio";
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(base: string, token: string | undefined, method: "GET" | "POST" | "PATCH", path: string, body?: unknown,
    extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${base}${path}`, {
        method, redirect: "error", signal: controller.signal,
        headers: { ...extraHeaders, ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Actio task request rejected (${response.status})`);
      }
      return await response.json() as unknown;
    } catch (error) {
      if (error instanceof Error && /^Actio task request rejected \(\d+\)$/.test(error.message)) throw error;
      throw new Error(classifyActioRequestFailure(method, controller.signal.aborted, error instanceof SyntaxError));
    } finally {
      clearTimeout(timer);
    }
  }
}
