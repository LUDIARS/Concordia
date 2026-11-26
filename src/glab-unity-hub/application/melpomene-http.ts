/**
 * HTTP `POST /v1/glab-unity/melpomene/reports` の手続き (契約 v1 §4a)。
 *
 * Bearer トークン必須。 海外監視とレート制限は WS と同じ (トークン毎分 60 要求・
 * 1 ユーザー毎分 10 投稿)。 本文は JSON (gzip の展開は adapter が済ませる)。
 *
 * @implements spec/feature/glab-unity-hub.md §4a (GUH-MELPOMENE)
 */

import { toHubError, type HubErrorCode } from "../domain/protocol.js";
import { HUB_LIMITS, SlidingWindowLimiter } from "../domain/rate-limit.js";
import { bearerToken, type HubAuthenticator } from "./authenticate.js";
import type { ConnectionOrigin, GeoGuard } from "./geo-guard.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { HubMelpomeneService } from "./melpomene-service.js";
import type { AuditLog, Clock } from "./ports.js";

export interface HttpReply {
  readonly status: number;
  readonly body: unknown;
}

const STATUS_OF: Record<HubErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  upstream_unavailable: 502,
  internal: 500,
};

export function httpError(code: HubErrorCode, message: string): HttpReply {
  return { status: STATUS_OF[code], body: { error: { code, message } } };
}

export interface MelpomeneHttpDeps {
  readonly authenticator: HubAuthenticator;
  readonly geo: GeoGuard;
  readonly registry: ConnectionRegistry;
  readonly melpomene: HubMelpomeneService;
  readonly audit: AuditLog;
  readonly clock: Clock;
}

export class MelpomeneHttpEndpoint {
  private readonly requests = new SlidingWindowLimiter(HUB_LIMITS.requestsPerConnectionPerMinute);

  constructor(private readonly deps: MelpomeneHttpDeps) {}

  async handle(input: { origin: ConnectionOrigin; authorization: string | string[] | undefined; bodyText: string }): Promise<HttpReply> {
    const verdict = this.deps.geo.admit(input.origin, "http");
    if (verdict.reason === "not_via_cloudflare") return httpError("forbidden", "connection must come through Cloudflare");
    const token = bearerToken(input.authorization);
    if (!token) return this.audited(null, null, httpError("unauthorized", "Authorization: Bearer <token> is required"));
    const outcome = await this.deps.authenticator.authenticate(token);
    if (!outcome.ok) {
      return this.audited(outcome.token?.id ?? null, outcome.token?.discordUserId ?? null, httpError(outcome.code, outcome.reason));
    }
    const identity = outcome.identity;
    if (!(await this.deps.geo.afterAuth(verdict, identity, "http"))) {
      return httpError("forbidden", "connection from outside allowed countries is blocked");
    }
    const now = this.deps.clock.now().getTime();
    if (!this.requests.tryHit(identity.token.id, now)) return httpError("rate_limited", "too many requests (60 per minute)");
    if (!this.deps.registry.posts.tryHit(identity.token.discordUserId, now)) return httpError("rate_limited", "too many posts (10 per minute)");
    let body: unknown;
    try {
      body = JSON.parse(input.bodyText) as unknown;
    } catch {
      return httpError("invalid_request", "body must be JSON");
    }
    try {
      return { status: 201, body: await this.deps.melpomene.submit(identity, body) };
    } catch (error) {
      const hubError = toHubError(error);
      return this.audited(identity.token.id, identity.token.discordUserId, httpError(hubError.code, hubError.message));
    }
  }

  private audited(tokenId: string | null, discordUserId: string | null, reply: HttpReply): HttpReply {
    const code = (reply.body as { error?: { code?: string } }).error?.code ?? "error";
    this.deps.audit.record({ kind: "http", tokenId, discordUserId, country: null, ip: null, operation: "melpomene.reports", result: code });
    return reply;
  }
}

