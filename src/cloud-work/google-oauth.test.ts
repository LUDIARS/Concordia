import { describe, expect, it, vi } from "vitest";
import { GoogleOAuthTokens } from "./google-oauth.js";

const binding = { clientIdEnv: "G_ID", clientSecretEnv: "G_SECRET", refreshTokenEnv: "G_REFRESH" };
const env = { G_ID: "client", G_SECRET: "never-display-secret", G_REFRESH: "refresh-value" };

describe("Google OAuth token source", () => {
  it("requires every bound secret before any request", () => {
    expect(() => new GoogleOAuthTokens(binding, { G_ID: "client" })).toThrow("cloud_drive_credentials_missing");
  });
  it("exchanges the refresh token without redirects and caches until shortly before expiry", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ access_token: "access-1", expires_in: 3600 }));
    const tokens = new GoogleOAuthTokens(binding, env, fetcher, () => now);
    expect(await tokens.accessToken()).toBe("access-1");
    expect(await tokens.accessToken()).toBe("access-1");
    expect(fetcher).toHaveBeenCalledOnce();
    const init = fetcher.mock.calls[0][1]!;
    expect(init.redirect).toBe("error");
    expect(String(init.body)).toContain("grant_type=refresh_token");
    now = 3_540_001;
    await tokens.accessToken();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("redacts provider failures", async () => {
    const failing = new GoogleOAuthTokens(binding, env, vi.fn<typeof fetch>(async () => new Response("invalid_grant never-display-secret", { status: 400 })));
    await expect(failing.accessToken()).rejects.toThrow("cloud_drive_auth_failed");
    const malformed = new GoogleOAuthTokens(binding, env, vi.fn<typeof fetch>(async () => Response.json({ token: "x" })));
    await expect(malformed.accessToken()).rejects.toThrow("cloud_drive_auth_failed");
  });
});
