import { describe, expect, it } from "vitest";
import { classifyReactionIngress } from "./reaction-ingress.js";

const classify = (emoji: string): "start" | null => emoji === "👍" ? "start" : null;
const standalone = (text: string): boolean => ["👍", "🙏"].includes(text);

describe("classifyReactionIngress", () => {
  it("routes mapped emoji to workflow", () => {
    expect(classifyReactionIngress({ text: " 👍 ", classify, isStandaloneEmoji: standalone })).toEqual({
      kind: "workflow",
      action: "start",
      emoji: "👍",
    });
  });

  it("rejects unsupported standalone and named emoji without forwarding a prompt", () => {
    expect(classifyReactionIngress({ text: "🙏", classify, isStandaloneEmoji: standalone })).toEqual({
      kind: "unsupported-emoji",
      emoji: "🙏",
    });
    expect(classifyReactionIngress({
      text: ":unknown:",
      classify,
      isStandaloneEmoji: standalone,
      isNamedEmoji: (text) => /^:[a-z]+:$/.test(text),
    }).kind).toBe("unsupported-emoji");
  });

  it("supports adapter-specific normalization", () => {
    expect(classifyReactionIngress({
      text: ":thumbsup:",
      normalize: () => "👍",
      classify,
      isStandaloneEmoji: standalone,
    }).kind).toBe("workflow");
  });
});
