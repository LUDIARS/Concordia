import { readCloudResponse } from "./artifact-transfer.js";

export interface GoogleOAuthBinding { clientIdEnv: string; clientSecretEnv: string; refreshTokenEnv: string }
export interface AccessTokenSource { accessToken(): Promise<string> }

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * @implements CC-CLOUD-DRIVE-02
 * Exchanges the operator's refresh token for short-lived access tokens. Only Cc holds these;
 * the cloud worker receives per-file upload sessions, never a Google credential.
 */
export class GoogleOAuthTokens implements AccessTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;

  constructor(binding: GoogleOAuthBinding, env: NodeJS.ProcessEnv,
    private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    const clientId = env[binding.clientIdEnv], clientSecret = env[binding.clientSecretEnv], refreshToken = env[binding.refreshTokenEnv];
    if (!clientId || !clientSecret || !refreshToken) throw new Error("cloud_drive_credentials_missing");
    this.clientId = clientId; this.clientSecret = clientSecret; this.refreshToken = refreshToken;
  }

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.token;
    let value: unknown;
    try {
      const response = await this.fetcher(TOKEN_URL, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.clientId,
          client_secret: this.clientSecret, refresh_token: this.refreshToken }).toString(),
      });
      value = JSON.parse((await readCloudResponse(response, 16_384)).toString("utf8"));
    } catch { throw new Error("cloud_drive_auth_failed"); }
    const body = value as { access_token?: unknown; expires_in?: unknown } | null;
    if (!body || typeof body.access_token !== "string" || !body.access_token
      || typeof body.expires_in !== "number" || body.expires_in <= 0) throw new Error("cloud_drive_auth_failed");
    // Refresh a minute early so a long collection never starts with an expiring token.
    this.cached = { token: body.access_token, expiresAt: this.now() + Math.max(0, body.expires_in - 60) * 1000 };
    return body.access_token;
  }
}
