import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

/**
 * Cloudflare Access の application token (Cf-Access-Jwt-Assertion) の検証 (CC-MGMT-08)。
 * 依存を足さず、 チームの公開鍵 (JWKS) で RS256 署名と iss / aud / exp / nbf を確かめる。
 * 参考実装: Elegantia src/runtime/cf-{jwt,access}.ts。
 */

export interface CfAccessConfig {
  teamDomain: string;
  audience: string;
}

/** 検証できた主体。 人間なら email、 サービストークンなら common_name (client id) が入る。 */
export interface CfAccessIdentity {
  email: string | null;
  commonName: string | null;
}

export type JwksFetcher = (url: string) => Promise<unknown>;

const AUDIENCE_TAG = /^[a-f0-9]{32,128}$/i;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const KEY_TTL_MS = 10 * 60 * 1000;
const UNKNOWN_KID_RETRY_MS = 60 * 1000;
const MAX_ASSERTION_LENGTH = 8192;

/** team / aud は両方そろって初めて有効。 片方だけは設定ミスとして throw する。 */
export function parseCfAccessConfig(teamDomain: string | undefined, audience: string | undefined): CfAccessConfig | null {
  const team = teamDomain?.trim() ?? "";
  const aud = audience?.trim() ?? "";
  if (!team && !aud) return null;
  if (!team || !aud) throw new Error("Cloudflare Access の team domain と audience は両方必要です");
  let url: URL;
  try { url = new URL(team); } catch { throw new Error("Cloudflare Access の team domain が不正です"); }
  if (url.protocol !== "https:" || url.origin !== team) throw new Error("Cloudflare Access の team domain が不正です");
  if (!AUDIENCE_TAG.test(aud)) throw new Error("Cloudflare Access の audience tag が不正です");
  return { teamDomain: team, audience: aud };
}

interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

function decodeObject(value: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

/** compact JWS を分解する。 中身は信用しない。 */
export function decodeJwt(token: string): JwtParts | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !SEGMENT.test(part))) return null;
  try {
    const header = decodeObject(parts[0]!);
    const payload = decodeObject(parts[1]!);
    if (!header || !payload) return null;
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2]!, "base64url") };
  } catch {
    return null;
  }
}

function verifyRs256(parts: JwtParts, jwk: JsonWebKey): boolean {
  if (parts.header.alg !== "RS256" || jwk.kty !== "RSA") return false;
  try {
    return verify("RSA-SHA256", Buffer.from(parts.signingInput, "utf8"), createPublicKey({ key: jwk, format: "jwk" }), parts.signature);
  } catch {
    return false;
  }
}

function claimsAccepted(payload: Record<string, unknown>, config: CfAccessConfig, nowMs: number): boolean {
  const now = Math.floor(nowMs / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return payload.iss === config.teamDomain && audiences.includes(config.audience)
    && typeof payload.exp === "number" && payload.exp > now
    && (payload.nbf === undefined || (typeof payload.nbf === "number" && payload.nbf <= now));
}

async function fetchJwksDefault(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("JWKS fetch failed");
  return response.json();
}

export class CfAccessVerifier {
  private readonly keys = new Map<string, JsonWebKey>();
  private fetchedAt = -Infinity;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly config: CfAccessConfig,
    private readonly fetchJwks: JwksFetcher = fetchJwksDefault,
    private readonly now: () => number = Date.now,
  ) {}

  /** 検証できなければ null。 例外は投げない (取得失敗も拒否として扱う)。 */
  async verify(assertion: string | undefined): Promise<CfAccessIdentity | null> {
    if (!assertion || assertion.length > MAX_ASSERTION_LENGTH) return null;
    const parts = decodeJwt(assertion);
    if (!parts || typeof parts.header.kid !== "string") return null;
    const key = await this.keyFor(parts.header.kid);
    if (!key || !verifyRs256(parts, key) || !claimsAccepted(parts.payload, this.config, this.now())) return null;
    return {
      email: typeof parts.payload.email === "string" ? parts.payload.email : null,
      commonName: typeof parts.payload.common_name === "string" ? parts.payload.common_name : null,
    };
  }

  private async keyFor(kid: string): Promise<JsonWebKey | undefined> {
    if (!this.keys.size || this.now() - this.fetchedAt > KEY_TTL_MS) await this.refresh();
    if (!this.keys.has(kid) && this.now() - this.fetchedAt > UNKNOWN_KID_RETRY_MS) await this.refresh();
    return this.keys.get(kid);
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async load(): Promise<void> {
    let body: unknown;
    try {
      body = await this.fetchJwks(`${this.config.teamDomain}/cdn-cgi/access/certs`);
    } catch {
      this.fetchedAt = this.now();
      return;
    }
    const keys = typeof body === "object" && body !== null && Array.isArray((body as { keys?: unknown }).keys)
      ? (body as { keys: unknown[] }).keys : [];
    this.keys.clear();
    for (const key of keys) {
      if (typeof key !== "object" || key === null) continue;
      const jwk = key as JsonWebKey & { kid?: unknown };
      if (typeof jwk.kid === "string" && jwk.kty === "RSA") this.keys.set(jwk.kid, jwk);
    }
    this.fetchedAt = this.now();
  }
}
