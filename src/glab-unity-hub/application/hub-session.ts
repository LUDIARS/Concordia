/**
 * WS 接続 1 本の進行 (契約 v1 §2 認証・制限・メッセージ形式)。
 *
 * 通信路 (Portus の WebSocket) を知らない。 送受信は `HubSocket` だけを通す。
 *
 * 1. 接続時に海外監視の一次判定 (CF 非経由は 4403)。
 * 2. `Authorization: Bearer` があれば即認証。 無ければ 5 秒以内の auth フレームを待つ。
 *    どちらも無ければ 4401。 失効・期限切れ・未知は 4401、 GLab から抜けた人は 4403。
 * 3. 認証後に海外判定 (記録・通知、 block なら 4403)、 同時接続 2 本の確認。
 * 4. 要求ごとに: 失効の見直し → 毎分 60 要求 → 投稿は毎分 10 件 → メソッド実行。
 *
 * @implements spec/feature/glab-unity-hub.md §2 (GUH-SESSION)
 */

import { errorFrame, eventFrame, HUB_CLOSE_CODES, MAX_FRAME_BYTES, parseFrame, resultFrame } from "../domain/protocol.js";
import { HUB_LIMITS, SlidingWindowLimiter } from "../domain/rate-limit.js";
import { isHubMethod, POSTING_METHODS } from "../domain/methods.js";
import { hashToken } from "../domain/token-policy.js";
import type { GeoVerdict } from "../domain/geo-policy.js";
import { bearerToken, type HubAuthenticator, type HubIdentity } from "./authenticate.js";
import type { ConnectionOrigin, GeoGuard } from "./geo-guard.js";
import type { ConnectionRegistry, RegisteredSession } from "./connection-registry.js";
import { dispatchMethod } from "./method-router.js";
import type { MethodHandlers } from "./method-context.js";
import type { AuditLog, Clock } from "./ports.js";

/** 通信路の最小の口。 */
export interface HubSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface HubSessionDeps {
  readonly socket: HubSocket;
  readonly origin: ConnectionOrigin;
  readonly authorization: string | string[] | undefined;
  readonly authenticator: HubAuthenticator;
  readonly geo: GeoGuard;
  readonly registry: ConnectionRegistry;
  readonly handlers: MethodHandlers;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

type State = "awaiting_auth" | "authenticating" | "open" | "closed";

const defaultTimer = (fn: () => void, ms: number) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
};

export class HubSession implements RegisteredSession {
  private state: State = "awaiting_auth";
  private identity: HubIdentity | null = null;
  private tokenHash = "";
  private verdict: GeoVerdict | null = null;
  private authTimer: { cancel(): void } | null = null;
  private readonly subscriptions = new Set<string>();
  private readonly requests = new SlidingWindowLimiter(HUB_LIMITS.requestsPerConnectionPerMinute);

  constructor(private readonly deps: HubSessionDeps) {}

  get tokenId(): string {
    return this.identity?.token.id ?? "";
  }

  get discordUserId(): string {
    return this.identity?.token.discordUserId ?? "";
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  /** 接続直後に呼ぶ。 */
  async start(): Promise<void> {
    this.verdict = this.deps.geo.admit(this.deps.origin, "ws");
    if (this.verdict.reason === "not_via_cloudflare") {
      this.terminate(HUB_CLOSE_CODES.forbidden, "connection must come through Cloudflare");
      return;
    }
    const token = bearerToken(this.deps.authorization);
    if (token) {
      await this.authenticate(token, null);
      return;
    }
    this.authTimer = (this.deps.setTimer ?? defaultTimer)(() => {
      if (this.state === "awaiting_auth") {
        this.recordAuth(null, "timeout");
        this.terminate(HUB_CLOSE_CODES.unauthorized, "auth required");
      }
    }, HUB_LIMITS.authFrameTimeoutMs);
  }

  /** テキストフレーム 1 枚。 バイナリは受けない。 */
  async receive(data: string | Buffer, isBinary: boolean): Promise<void> {
    if (this.state === "closed") return;
    if (isBinary) {
      this.deps.socket.send(errorFrame(null, "invalid_request", "binary frames are not supported"));
      return;
    }
    const text = typeof data === "string" ? data : data.toString("utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
      this.deps.socket.send(errorFrame(null, "invalid_request", "frame too large"));
      return;
    }
    const frame = parseFrame(text);
    if (this.state === "awaiting_auth") {
      if (frame.kind !== "auth") {
        this.recordAuth(null, "missing_auth_frame");
        this.terminate(HUB_CLOSE_CODES.unauthorized, "auth required");
        return;
      }
      await this.authenticate(frame.auth.token, frame.auth.id);
      return;
    }
    if (this.state !== "open" || !this.identity) return;
    if (frame.kind === "auth") {
      this.deps.socket.send(errorFrame(frame.auth.id, "invalid_request", "already authenticated"));
      return;
    }
    if (frame.kind === "invalid") {
      this.deps.socket.send(errorFrame(frame.id, "invalid_request", frame.message));
      return;
    }
    await this.handleRequest(frame.request.id, frame.request.type, frame.request.payload);
  }

  /** 通信路が閉じた。 */
  closed(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.authTimer?.cancel();
    this.deps.registry.remove(this);
  }

  isSubscribed(channelId: string): boolean {
    return this.state === "open" && this.subscriptions.has(channelId);
  }

  pushEvent(event: string, data: unknown): void {
    if (this.state === "open") this.deps.socket.send(eventFrame(event, data));
  }

  terminate(code: number, reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.authTimer?.cancel();
    this.deps.registry.remove(this);
    this.deps.socket.close(code, reason);
  }

  private async authenticate(token: string, frameId: string | null): Promise<void> {
    this.state = "authenticating";
    this.authTimer?.cancel();
    const outcome = await this.deps.authenticator.authenticate(token);
    if (this.state !== "authenticating") return;
    if (!outcome.ok) {
      this.recordAuth(outcome.token?.id ?? null, outcome.reason, outcome.token?.discordUserId ?? null);
      this.terminate(outcome.code === "forbidden" ? HUB_CLOSE_CODES.forbidden : HUB_CLOSE_CODES.unauthorized, outcome.reason);
      return;
    }
    this.identity = outcome.identity;
    this.tokenHash = hashToken(token);
    const allowed = await this.deps.geo.afterAuth(this.verdict!, outcome.identity, "ws");
    if (!allowed) {
      this.terminate(HUB_CLOSE_CODES.forbidden, "connection from outside allowed countries is blocked");
      return;
    }
    if (!this.deps.registry.add(this)) {
      this.recordAuth(outcome.identity.token.id, "too_many_connections", outcome.identity.token.discordUserId);
      this.deps.socket.send(errorFrame(frameId, "rate_limited", "too many concurrent connections for this token"));
      this.state = "closed";
      this.deps.socket.close(1008, "too many connections");
      return;
    }
    this.state = "open";
    this.recordAuth(outcome.identity.token.id, "ok", outcome.identity.token.discordUserId);
    // auth フレームに id があれば受領を返す (ヘッダ認証では何も送らない)。
    if (frameId !== null) this.deps.socket.send(resultFrame(frameId, { authenticated: true }));
  }

  private async handleRequest(id: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const identity = this.identity!;
    if (!this.deps.authenticator.stillActive(identity.token.id, this.tokenHash)) {
      this.terminate(HUB_CLOSE_CODES.unauthorized, "token is no longer valid");
      return;
    }
    const now = this.deps.clock.now().getTime();
    if (!this.requests.tryHit("connection", now)) {
      this.deps.socket.send(errorFrame(id, "rate_limited", "too many requests (60 per minute)"));
      return;
    }
    if (isHubMethod(type) && POSTING_METHODS.has(type) && !this.deps.registry.posts.tryHit(identity.token.discordUserId, now)) {
      this.deps.socket.send(errorFrame(id, "rate_limited", "too many posts (10 per minute)"));
      return;
    }
    const outcome = await dispatchMethod(this.deps.handlers, {
      identity,
      subscriptions: {
        subscribe: (channelId) => { this.subscriptions.add(channelId); },
        unsubscribe: (channelId) => { this.subscriptions.delete(channelId); },
      },
    }, type, payload);
    this.deps.audit.record({
      kind: "operation", tokenId: identity.token.id, discordUserId: identity.token.discordUserId,
      country: this.verdict?.country ?? null, ip: this.verdict?.maskedIp ?? null,
      operation: type.slice(0, 64), result: outcome.ok ? "ok" : outcome.error.code,
    });
    if (this.state !== "open") return;
    this.deps.socket.send(outcome.ok ? resultFrame(id, outcome.payload) : errorFrame(id, outcome.error.code, outcome.error.message));
  }

  private recordAuth(tokenId: string | null, result: string, discordUserId: string | null = null): void {
    this.deps.audit.record({
      kind: "auth", tokenId, discordUserId, country: this.verdict?.country ?? null, ip: this.verdict?.maskedIp ?? null,
      operation: "ws.auth", result,
    });
  }
}
