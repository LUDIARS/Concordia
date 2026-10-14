/**
 * Google のサービスアカウントのアクセストークン (spec/feature/tech-consultation.md §6.4)。
 *
 * 鍵で署名した JWT (RS256) を token endpoint に渡して受け取る (OAuth 2.0 JWT bearer)。 依存パッケージを足さず node:crypto で署名する。
 * トークンは期限の 60 秒前まで使い回す。 失敗時の例外にトークン・鍵・応答本文を載せない。
 *
 * @implements SPEC-CONSULT-DRIVE-TRANSFER
 */

import { createSign } from "node:crypto";
import type { ServiceAccountKey } from "./drive-transfer-config.js";
import { DriveTransferError } from "./drive-transfer-port.js";

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface AccessTokenSource {
  token(): Promise<string>;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** token endpoint に渡す署名済み assertion。 有効期限は 1 時間 (Google の上限)。 */
export function signServiceAccountAssertion(key: ServiceAccountKey, scope: string, nowSec: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: key.clientEmail, scope, aud: key.tokenUri, iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(key.privateKey))}`;
}

export function createServiceAccountTokenSource(
  key: ServiceAccountKey,
  options: { fetchImpl?: FetchLike; now?: () => number; scope?: string } = {},
): AccessTokenSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const scope = options.scope ?? GOOGLE_DRIVE_SCOPE;
  let cached: { token: string; expiresAt: number } | null = null;
  return {
    async token() {
      if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
      let assertion: string;
      try {
        assertion = signServiceAccountAssertion(key, scope, Math.floor(now() / 1000));
      } catch {
        // 鍵が壊れている (PEM として読めない)。
        throw new DriveTransferError("unauthorized", null);
      }
      let response: Response;
      try {
        response = await fetchImpl(key.tokenUri, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        });
      } catch {
        throw new DriveTransferError("unreachable", null);
      }
      if (!response.ok) throw new DriveTransferError("unauthorized", response.status);
      const body = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
      if (typeof body?.access_token !== "string" || !body.access_token) throw new DriveTransferError("malformed_response", response.status);
      const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
      cached = { token: body.access_token, expiresAt: now() + expiresIn * 1000 };
      return cached.token;
    },
  };
}
