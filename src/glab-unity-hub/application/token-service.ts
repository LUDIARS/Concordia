/**
 * `/glab-unity-token` の use case (契約 v1 §1)。
 *
 * 発行・一覧・失効はすべて **コマンドを打った本人** のトークンだけを対象にする。 引数に
 * 対象ユーザーを持たないので、 管理者でも他人の分は作れない・消せない。
 * 失効は DB に書くだけで、 接続中の WS は Hub が失効を拾って 4401 で切る (connection-registry)。
 *
 * @implements spec/feature/glab-unity-hub.md §1 (GUH-TOKEN)
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  decideIssue,
  displayPrefixOf,
  expiresAtFrom,
  formatToken,
  hashToken,
  matchRevokeTarget,
  normalizeLabel,
  TOKEN_RANDOM_BYTES,
  tokenState,
  type StoredToken,
} from "../domain/token-policy.js";
import type { AuditLog, Clock, TokenStore } from "./ports.js";

export interface TokenActor {
  readonly discordUserId: string;
  /** コマンドが打たれた guild。 DM なら null。 */
  readonly guildId: string | null;
}

export type IssueResult =
  | { readonly ok: true; readonly token: string; readonly displayPrefix: string; readonly expiresAt: string; readonly label: string | null }
  | { readonly ok: false; readonly reason: "limit_reached" | "wrong_guild" };

export interface TokenListItem {
  readonly displayPrefix: string;
  readonly label: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
}

export type RevokeResult =
  | { readonly ok: true; readonly displayPrefix: string }
  | { readonly ok: false; readonly reason: "not_found" | "ambiguous" | "prefix_too_short" | "wrong_guild" };

export interface TokenServiceDeps {
  readonly store: TokenStore;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly glabGuildId: string;
  /** 乱数源。 既定は crypto.randomBytes。 */
  readonly random?: (size: number) => Uint8Array;
}

/** Discord コマンドが使う範囲。 */
export type GlabUnityTokenCommandPort = Pick<GlabUnityTokenService, "issue" | "list" | "revoke">;

export class GlabUnityTokenService {
  constructor(private readonly deps: TokenServiceDeps) {}

  issue(actor: TokenActor, rawLabel: string | null): IssueResult {
    const now = this.deps.clock.now();
    const active = this.activeTokens(actor.discordUserId, now);
    const decision = decideIssue({ guildId: actor.guildId, glabGuildId: this.deps.glabGuildId, activeTokenCount: active.length });
    if (!decision.ok) {
      this.audit(actor, "issue", decision.reason);
      return decision;
    }
    const token = formatToken((this.deps.random ?? randomBytes)(TOKEN_RANDOM_BYTES));
    const label = normalizeLabel(rawLabel);
    const stored: StoredToken = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      displayPrefix: displayPrefixOf(token),
      discordUserId: actor.discordUserId,
      guildId: actor.guildId!,
      label,
      createdAt: now.toISOString(),
      expiresAt: expiresAtFrom(now),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.deps.store.insert(stored);
    this.audit(actor, "issue", "ok", stored.id);
    return { ok: true, token, displayPrefix: stored.displayPrefix, expiresAt: stored.expiresAt, label };
  }

  list(actor: TokenActor): TokenListItem[] | { ok: false; reason: "wrong_guild" } {
    if (actor.guildId !== this.deps.glabGuildId) return { ok: false, reason: "wrong_guild" };
    return this.activeTokens(actor.discordUserId, this.deps.clock.now()).map((token) => ({
      displayPrefix: token.displayPrefix,
      label: token.label,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
    }));
  }

  revoke(actor: TokenActor, prefix: string): RevokeResult {
    if (actor.guildId !== this.deps.glabGuildId) return { ok: false, reason: "wrong_guild" };
    const now = this.deps.clock.now();
    const match = matchRevokeTarget(this.deps.store.listByUser(actor.discordUserId), prefix, now);
    if (!match.ok) {
      this.audit(actor, "revoke", match.reason);
      return match;
    }
    // 本人のトークンの中から選んでいるので、 他人のトークンには届かない。
    if (match.token.discordUserId !== actor.discordUserId) return { ok: false, reason: "not_found" };
    this.deps.store.revoke(match.token.id, now.toISOString());
    this.audit(actor, "revoke", "ok", match.token.id);
    return { ok: true, displayPrefix: match.token.displayPrefix };
  }

  private activeTokens(discordUserId: string, now: Date): StoredToken[] {
    return this.deps.store.listByUser(discordUserId).filter((token) => tokenState(token, now) === "active");
  }

  private audit(actor: TokenActor, operation: string, result: string, tokenId: string | null = null): void {
    this.deps.audit.record({
      kind: "token", tokenId, discordUserId: actor.discordUserId, country: null, ip: null,
      operation: `token.${operation}`, result,
    });
  }
}
