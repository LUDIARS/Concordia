import { describe, expect, it } from "vitest";
import {
  buildDiscordWebhookIdentity,
  delegationEmojiAvatarUrl,
  friendlyModelName,
} from "./webhook-identity.js";

describe("Discord webhook identity", () => {
  it("combines a friendly model name with the stable delegation call name", () => {
    expect(buildDiscordWebhookIdentity({
      model: "claude-fable-5",
      provider: "claude",
      callName: "impl-from-design",
      currentTask: "a less stable task summary",
      delegationEmoji: "🦸",
    })).toEqual({
      username: "Fable 5 · impl-from-design",
      avatarURL:
        "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f9b8.png",
    });
  });

  it("falls back through current task, role, and provider", () => {
    expect(buildDiscordWebhookIdentity({
      model: "gpt-5.6-sol",
      currentTask: "  Fix   the forum surface  ",
      roleLabel: "worker",
    }).username).toBe("GPT-5.6 Sol · Fix the forum surface");
    expect(buildDiscordWebhookIdentity({
      provider: "codex-cli",
      roleLabel: "worker",
    }).username).toBe("Codex · worker");
  });

  it("keeps the composed username within Discord's 80-character limit", () => {
    const identity = buildDiscordWebhookIdentity({
      model: "gpt-5.6-terra",
      callName: "x".repeat(200),
    });
    expect(identity.username).toHaveLength(80);
    expect(identity.username).toMatch(/^GPT-5\.6 Terra · /);
  });

  it("uses readable names for known and generic models", () => {
    expect(friendlyModelName("claude-fable-5")).toBe("Fable 5");
    expect(friendlyModelName("claude-opus-5")).toBe("Opus 5");
    expect(friendlyModelName("gpt-5.6-luna")).toBe("GPT-5.6 Luna");
    expect(friendlyModelName("claude-custom-7")).toBe("Custom 7");
  });
});

describe("delegation emoji avatar URL", () => {
  it("strips variation selectors", () => {
    expect(delegationEmojiAvatarUrl("❤️")).toBe(
      "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/2764.png",
    );
  });

  it("preserves ZWJ sequences", () => {
    expect(delegationEmojiAvatarUrl("👩‍💻")).toBe(
      "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f469-200d-1f4bb.png",
    );
  });

  it("omits unusable values", () => {
    expect(delegationEmojiAvatarUrl(null)).toBeNull();
    expect(delegationEmojiAvatarUrl("")).toBeNull();
    expect(delegationEmojiAvatarUrl("not-an-emoji")).toBeNull();
  });
});
