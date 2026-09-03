import { describe, expect, it } from "vitest";
import { readSpawnEmoji } from "./spawn-emoji.js";

describe("readSpawnEmoji", () => {
  it("短い複合 emoji を trim して受け入れる", () => {
    expect(readSpawnEmoji("  🧙‍♂️  ")).toBe("🧙‍♂️");
  });

  it.each([
    ["空文字", ""],
    ["内部空白", "🧙 🦸"],
    ["過長", "123456789"],
    ["非文字列", 42],
  ])("%s は無効として捨てる", (_label, value) => {
    expect(readSpawnEmoji(value)).toBeNull();
  });
});
