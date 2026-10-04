import { describe, expect, it } from "vitest";
import { consultClaudeLoginState, consultClaudeReloginCommand } from "./consult-claude-login.js";

const now = Date.parse("2026-10-04T00:00:00Z");
const creds = (oauth: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: oauth });

describe("consultClaudeLoginState", () => {
  it("更新用トークンがあり期限内なら起動できる (アクセストークンの期限切れは claude が更新するので止めない)", () => {
    expect(consultClaudeLoginState(creds({
      accessToken: "a", expiresAt: now - 86_400_000, refreshToken: "r", refreshTokenExpiresAt: now + 86_400_000,
    }), now)).toEqual({ ready: true });
    // 期限の欄が無い古い形式も、 更新用トークンがあれば起動する。
    expect(consultClaudeLoginState(creds({ refreshToken: "r" }), now)).toEqual({ ready: true });
  });

  it("ファイルが無い・壊れている・更新用トークンが無い・期限切れは起動しない", () => {
    expect(consultClaudeLoginState(null, now)).toEqual({ ready: false, reason: "missing" });
    expect(consultClaudeLoginState("{", now)).toEqual({ ready: false, reason: "unreadable" });
    expect(consultClaudeLoginState(JSON.stringify({}), now)).toEqual({ ready: false, reason: "unreadable" });
    expect(consultClaudeLoginState(creds({ accessToken: "a" }), now)).toEqual({ ready: false, reason: "no_refresh_token" });
    expect(consultClaudeLoginState(creds({ refreshToken: "r", refreshTokenExpiresAt: now - 1 }), now))
      .toEqual({ ready: false, reason: "refresh_expired" });
  });

  it("再ログインのコマンドに設定フォルダを入れる", () => {
    expect(consultClaudeReloginCommand("E:\\Document\\Consult\\.claude-config")).toContain('CLAUDE_CONFIG_DIR = "E:\\Document\\Consult\\.claude-config"');
  });
});
