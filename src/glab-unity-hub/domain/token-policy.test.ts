import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decideIssue,
  displayPrefixOf,
  expiresAtFrom,
  formatToken,
  hashToken,
  isWellFormedToken,
  matchRevokeTarget,
  MAX_ACTIVE_TOKENS_PER_USER,
  normalizeLabel,
  TOKEN_PREFIX,
  tokenMatchesHash,
  tokenState,
  type StoredToken,
} from "./token-policy.js";

// トークン文字列は固定リテラルにせず乱数で作る (Revisor の情報流出検査対策、 契約 §1)。
const freshToken = () => formatToken(randomBytes(32));
const NOW = new Date("2026-11-26T00:00:00.000Z");

function stored(token: string, patch: Partial<StoredToken> = {}): StoredToken {
  return {
    id: patch.id ?? `id-${displayPrefixOf(token)}`,
    tokenHash: hashToken(token),
    displayPrefix: displayPrefixOf(token),
    discordUserId: "111111111111111111",
    guildId: "222222222222222222",
    label: null,
    createdAt: NOW.toISOString(),
    expiresAt: expiresAtFrom(NOW),
    lastUsedAt: null,
    revokedAt: null,
    ...patch,
  };
}

describe("GLab-UnityHub token policy", () => {
  it("glu_ + 32 byte の base64url で作り、 形を検査できる", () => {
    const token = freshToken();
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token).toHaveLength(TOKEN_PREFIX.length + 43);
    expect(isWellFormedToken(token)).toBe(true);
    expect(isWellFormedToken(token.slice(0, -1))).toBe(false);
    expect(() => formatToken(randomBytes(16))).toThrow();
  });

  it("保存するのは SHA-256 のハッシュだけで、 平文と照合できる", () => {
    const token = freshToken();
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 8));
    expect(tokenMatchesHash(token, hash)).toBe(true);
    expect(tokenMatchesHash(freshToken(), hash)).toBe(false);
  });

  it("既定 30 日で期限切れ、 失効は期限より優先する", () => {
    const token = stored(freshToken());
    expect(tokenState(token, NOW)).toBe("active");
    expect(tokenState(token, new Date(NOW.getTime() + 31 * 24 * 3600 * 1000))).toBe("expired");
    expect(tokenState({ ...token, revokedAt: NOW.toISOString() }, NOW)).toBe("revoked");
  });

  it("発行は GLab の guild だけ、 有効トークンは 3 本まで", () => {
    const glab = "222222222222222222";
    expect(decideIssue({ guildId: glab, glabGuildId: glab, activeTokenCount: 0 })).toEqual({ ok: true });
    expect(decideIssue({ guildId: null, glabGuildId: glab, activeTokenCount: 0 })).toEqual({ ok: false, reason: "wrong_guild" });
    expect(decideIssue({ guildId: "333333333333333333", glabGuildId: glab, activeTokenCount: 0 })).toEqual({ ok: false, reason: "wrong_guild" });
    expect(decideIssue({ guildId: glab, glabGuildId: glab, activeTokenCount: MAX_ACTIVE_TOKENS_PER_USER }))
      .toEqual({ ok: false, reason: "limit_reached" });
  });

  it("失効の対象は本人の有効なトークンから前方一致で 1 本だけ選ぶ", () => {
    const a = stored(freshToken(), { id: "a" });
    const b = stored(freshToken(), { id: "b" });
    const match = matchRevokeTarget([a, b], a.displayPrefix, NOW);
    expect(match).toEqual({ ok: true, token: a });
    expect(matchRevokeTarget([a, b], TOKEN_PREFIX, NOW)).toEqual({ ok: false, reason: "prefix_too_short" });
    expect(matchRevokeTarget([{ ...a, revokedAt: NOW.toISOString() }], a.displayPrefix, NOW)).toEqual({ ok: false, reason: "not_found" });
    const twin = { ...b, displayPrefix: a.displayPrefix };
    expect(matchRevokeTarget([a, twin], a.displayPrefix, NOW)).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("ラベルは制御文字を落として 64 文字に切り、 空は null", () => {
    expect(normalizeLabel("  ")).toBeNull();
    expect(normalizeLabel(null)).toBeNull();
    expect(normalizeLabel("自宅\u0007PC")).toBe("自宅PC");
    expect(normalizeLabel("x".repeat(100))).toHaveLength(64);
  });
});
