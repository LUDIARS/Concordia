/**
 * GLab-UnityHub のトークン規則 (契約 v1 §1)。
 *
 * - 形式は `glu_` + 32 byte 乱数の base64url。 平文は発行時に 1 回だけ返し、 保存するのは SHA-256 だけ。
 * - 既定の有効期限は 30 日、 1 ユーザーの有効トークンは 3 本まで。
 * - 失効・期限切れ・未知は同じ「使えない」(close 4401) に落とす。
 *
 * 乱数源と時刻は引数で受ける (テストが固定リテラルのトークンを持たなくて済むように)。
 *
 * @implements spec/feature/glab-unity-hub.md §1 (GUH-TOKEN)
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:21a66f06 */
import augurContract_92517689 from './issue-decision.contract.js'; /* augur-inject:contract-predicate:26d2b0fb */
import augurContract_4ffa04f7 from './token-hash.contract.js'; /* augur-inject:contract-predicate:c0dfce8e */

export const TOKEN_PREFIX = "glu_";
export const TOKEN_RANDOM_BYTES = 32;
export const DEFAULT_TOKEN_TTL_DAYS = 30;
export const MAX_ACTIVE_TOKENS_PER_USER = 3;
/** `list` / `revoke` で本人に見せる識別子の長さ (`glu_` を含む)。 平文の残りは見せない。 */
export const DISPLAY_PREFIX_LENGTH = 12;
export const MAX_LABEL_LENGTH = 64;

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_RE = /^glu_[A-Za-z0-9_-]{43}$/;

export interface StoredToken {
  readonly id: string;
  readonly tokenHash: string;
  readonly displayPrefix: string;
  readonly discordUserId: string;
  readonly guildId: string;
  readonly label: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export type TokenState = "active" | "revoked" | "expired";

/** 乱数 32 byte からトークン平文を作る。 */
export function formatToken(random: Uint8Array): string {
  if (random.length !== TOKEN_RANDOM_BYTES) throw new Error("token random must be 32 bytes");
  return TOKEN_PREFIX + Buffer.from(random).toString("base64url");
}

/** 形が合わないものは DB を引く前に未知として扱う。 */
export function isWellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 保存済みハッシュと平文の照合 (長さが違えば false)。 */
export function tokenMatchesHash(token: string, storedHash: string): boolean {
  const given = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return given.length === stored.length && timingSafeEqual(given, stored);
}

export function displayPrefixOf(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LENGTH);
}

export function expiresAtFrom(now: Date, ttlDays = DEFAULT_TOKEN_TTL_DAYS): string {
  return new Date(now.getTime() + ttlDays * DAY_MS).toISOString();
}

export function tokenState(token: Pick<StoredToken, "revokedAt" | "expiresAt">, now: Date): TokenState {
  if (token.revokedAt) return "revoked";
  const expires = Date.parse(token.expiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return "expired";
  return "active";
}

/** ラベルは任意。 空白は null、 制御文字は落とし、 長さを切る。 */
export function normalizeLabel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_LABEL_LENGTH);
  return cleaned === "" ? null : cleaned;
}

export type IssueDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "limit_reached" | "wrong_guild" };

/**
 * 発行してよいか。 発行対象は常にコマンドを打った本人なので、 対象ユーザーを引数に持たない。
 * GLab の guild 以外 (DM を含む) からは発行しない。
 */
export function decideIssue(input: {
  readonly guildId: string | null;
  readonly glabGuildId: string;
  readonly activeTokenCount: number;
}): IssueDecision {
  if (!input.guildId || input.guildId !== input.glabGuildId) return { ok: false, reason: "wrong_guild" };
  if (input.activeTokenCount >= MAX_ACTIVE_TOKENS_PER_USER) return { ok: false, reason: "limit_reached" };
  return { ok: true };
}

export type RevokeMatch =
  | { readonly ok: true; readonly token: StoredToken }
  | { readonly ok: false; readonly reason: "not_found" | "ambiguous" | "prefix_too_short" };

/** 本人のトークンの中から前方一致で 1 本だけ選ぶ。 他人のトークンは候補に入れない。 */
export function matchRevokeTarget(ownTokens: readonly StoredToken[], prefix: string, now: Date): RevokeMatch {
  const wanted = prefix.trim();
  if (wanted.length < TOKEN_PREFIX.length + 4) return { ok: false, reason: "prefix_too_short" };
  const candidates = ownTokens.filter((token) =>
    tokenState(token, now) === "active"
    && (token.displayPrefix.startsWith(wanted) || wanted.startsWith(token.displayPrefix)));
  if (candidates.length === 0) return { ok: false, reason: "not_found" };
  if (candidates.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, token: candidates[0]! };
}
// @ts-expect-error augur-inject
decideIssue = contract(decideIssue, { ...augurContract_92517689, contractId: 'guh-C-1', mode: 'observe', sample: 1, where: 'src/glab-unity-hub/domain/token-policy.ts:96', rule: 'contract-wrap', id: '92517689' }); /* augur-inject:contract-wrap:92517689 */
// @ts-expect-error augur-inject
hashToken = contract(hashToken, { ...augurContract_4ffa04f7, contractId: 'guh-C-2', mode: 'observe', sample: 1, where: 'src/glab-unity-hub/domain/token-policy.ts:55', rule: 'contract-wrap', id: '4ffa04f7' }); /* augur-inject:contract-wrap:4ffa04f7 */
