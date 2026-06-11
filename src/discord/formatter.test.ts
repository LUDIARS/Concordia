import { describe, it, expect } from "vitest";
import {
  agentEmoji,
  buildSessionChannelName,
  chatEmbed,
  chunkForDiscord,
  DISCORD_MAX_CONTENT,
  formatAuthorName,
  questionEmbed,
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
  it("agent type + role slug", () => {
    expect(sessionChannelSlug("claude-code", "テスト魂")).toBe("claude-テスト魂");
    expect(sessionChannelSlug("codex-cli", "Lint Cop")).toBe("codex-lint-cop");
  });
  it("role が null なら anon", () => {
    expect(sessionChannelSlug("gemini-cli", null)).toBe("gemini-anon");
  });
  it("agent type が空なら agent fallback", () => {
    expect(sessionChannelSlug(null, "Test Cop")).toBe("agent-test-cop");
  });
});

describe("agentEmoji / buildSessionChannelName", () => {
  it("agentEmoji: provider 別", () => {
    expect(agentEmoji("claude-code")).toBe("🧙");
    expect(agentEmoji("codex-cli")).toBe("🤖");
    expect(agentEmoji("gemini-cli")).toBe("♊");
    expect(agentEmoji(null)).toBe("🔹");
  });
  it("buildSessionChannelName: <状態><エージェント>-body", () => {
    expect(buildSessionChannelName("active", "claude-code", "architect")).toBe("🟢🧙-architect");
    expect(buildSessionChannelName("working", "codex-cli", "di-クローラ機能作成")).toBe("⚙️🤖-di-クローラ機能作成");
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

describe("embed builders", () => {
  it("chatEmbed sets author + description", () => {
    const e = chatEmbed({ channel: "chitchat", text: "hello", authorName: "alice", ts: 1 });
    const j = e.toJSON();
    expect(j.author?.name).toBe("alice");
    expect(j.description).toBe("hello");
  });

  it("questionEmbed includes options fields", () => {
    const e = questionEmbed({ question: "q?", options: ["a", "b"], questionId: 12 });
    const j = e.toJSON();
    expect(j.fields?.length).toBe(2);
    expect(j.footer?.text).toContain("12");
  });
});
