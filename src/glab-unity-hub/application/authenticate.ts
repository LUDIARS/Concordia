/**
 * トークンで本人を確かめる (契約 v1 §2 認証)。
 *
 * - 未知・形違い・失効・期限切れは 4401 (`unauthorized`)。
 * - トークンは有効でも、 GLab の Discord から抜けた人は 4403 (`forbidden`)。
 *
 * WS (ヘッダ / auth フレーム) と HTTP (Melpomene) の両方がここを通る。
 *
 * @implements spec/feature/glab-unity-hub.md §2 (GUH-AUTH)
 */

import { hashToken, isWellFormedToken, tokenState, type StoredToken } from "../domain/token-policy.js";
import type { Clock, DiscordGateway, HubMember, TokenStore } from "./ports.js";

export interface HubIdentity {
  readonly token: StoredToken;
  readonly member: HubMember;
}

export type AuthOutcome =
  | { readonly ok: true; readonly identity: HubIdentity }
  | { readonly ok: false; readonly code: "unauthorized" | "forbidden"; readonly reason: string; readonly token: StoredToken | null };

export interface AuthenticatorDeps {
  readonly store: TokenStore;
  readonly discord: Pick<DiscordGateway, "member">;
  readonly clock: Clock;
}

/** `Authorization: Bearer <token>` から平文を取り出す。 無ければ null。 */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value ?? "");
  return match ? match[1]! : null;
}

export class HubAuthenticator {
  constructor(private readonly deps: AuthenticatorDeps) {}

  async authenticate(plain: string): Promise<AuthOutcome> {
    if (!isWellFormedToken(plain)) return { ok: false, code: "unauthorized", reason: "malformed", token: null };
    const token = this.deps.store.findByHash(hashToken(plain));
    if (!token) return { ok: false, code: "unauthorized", reason: "unknown", token: null };
    const now = this.deps.clock.now();
    const state = tokenState(token, now);
    if (state !== "active") return { ok: false, code: "unauthorized", reason: state, token };
    const member = await this.deps.discord.member(token.discordUserId);
    if (!member) return { ok: false, code: "forbidden", reason: "left_guild", token };
    this.deps.store.touch(token.id, now.toISOString());
    return { ok: true, identity: { token, member } };
  }

  /** 接続中に失効・期限切れになっていないか (要求ごとに見直す)。 */
  stillActive(tokenId: string, hash: string): boolean {
    const token = this.deps.store.findByHash(hash);
    return token !== null && token.id === tokenId && tokenState(token, this.deps.clock.now()) === "active";
  }
}
