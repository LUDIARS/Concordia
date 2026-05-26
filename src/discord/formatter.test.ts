import { describe, it, expect } from "vitest";
import {
  applyStatusEmoji,
  chunkForDiscord,
  DISCORD_MAX_CONTENT,
  formatAuthorName,
  roleSlug,
  sessionChannelSlug,
} from "./formatter.js";

describe("roleSlug", () => {
  it("ASCII を lowercase + hyphen に正規化", () => {
    expect(roleSlug("Test Cop")).toBe("test-cop");
    expect(roleSlug("infra-mage")).toBe("infra-mage");
    expect(roleSlug("Code  Reviewer!")).toBe("code-reviewer");
  });
  it("日本語はそのまま通す", () => {
    expect(roleSlug("テスト魂")).toBe("テスト魂");
  });
  it("空 / 記号だけは 'role' fallback", () => {
    expect(roleSlug("")).toBe("role");
    expect(roleSlug("---")).toBe("role");
    expect(roleSlug("!@#$")).toBe("role");
  });
});

describe("sessionChannelSlug", () => {
  it("lictor- prefix を剥がして先頭 4 文字 + role slug", () => {
    expect(sessionChannelSlug("lictor-bdea61ec-8f36-4e9f", "テスト魂")).toBe("s-bdea-テスト魂");
    expect(sessionChannelSlug("anon", "Lint Cop")).toBe("s-anon-lint-cop");
  });
  it("role が null なら anon", () => {
    expect(sessionChannelSlug("lictor-12345678", null)).toBe("s-1234-anon");
  });
});

describe("applyStatusEmoji", () => {
  it("既存 emoji を置き換える", () => {
    expect(applyStatusEmoji("🟢-s-bdea-foo", "lost")).toBe("🟥-s-bdea-foo");
    expect(applyStatusEmoji("🟥-s-bdea-foo", "ended")).toBe("⚪-s-bdea-foo");
    expect(applyStatusEmoji("⚪-s-bdea-foo", "active")).toBe("🟢-s-bdea-foo");
  });
  it("emoji 無しなら付ける", () => {
    expect(applyStatusEmoji("s-bdea-foo", "active")).toBe("🟢-s-bdea-foo");
  });
});

describe("chunkForDiscord", () => {
  it("max 以下なら 1 chunk", () => {
    expect(chunkForDiscord("hello")).toEqual(["hello"]);
  });
  it("空文字は空配列", () => {
    expect(chunkForDiscord("")).toEqual([]);
  });
  it("長文を段落で分ける", () => {
    const long = "a".repeat(1000) + "\n\n" + "b".repeat(1000) + "\n\n" + "c".repeat(500);
    const chunks = chunkForDiscord(long, 1500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1500);
    }
  });
  it("段落区切りが無くても強制切断", () => {
    const long = "x".repeat(5000);
    const chunks = chunkForDiscord(long, 1900);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_MAX_CONTENT);
    expect(chunks.join("")).toHaveLength(5000);
  });
});

describe("formatAuthorName", () => {
  it("display_name (role) を作る", () => {
    expect(formatAuthorName("境野 詰", "テスト魂")).toBe("境野 詰 (テスト魂)");
  });
  it("display_name と role が同じなら片方だけ", () => {
    expect(formatAuthorName("テスト魂", "テスト魂")).toBe("テスト魂");
  });
  it("display_name 無し → role", () => {
    expect(formatAuthorName(null, "テスト魂")).toBe("テスト魂");
  });
  it("両方無し → Concordia", () => {
    expect(formatAuthorName(null, null)).toBe("Concordia");
  });
});
