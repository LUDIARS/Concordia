import { describe, expect, it } from "vitest";
import { PATROL_CHARACTERS, characterById, characterPromptSection, pickCharacter } from "./patrol-characters.js";
import { buildPrompt } from "./render-patrol.js";

describe("patrol characters", () => {
  it("picks a character deterministically from the seed", () => {
    expect(pickCharacter(42).id).toBe(pickCharacter(42).id);
    const ids = new Set(Array.from({ length: 40 }, (_, i) => pickCharacter(i).id));
    expect(ids.size).toBe(PATROL_CHARACTERS.length);
    expect(pickCharacter(5, ["dev"]).id).toBe("dev");
    expect(characterById("nope")).toBeNull();
  });

  it("tells the writer to avoid bland opener phrases and to state an opinion", () => {
    const section = characterPromptSection(characterById("tsukkomi")!);
    expect(section).toContain("ツッコミ役");
    expect(section).toMatch(/「〜んですね」「〜ですよね」/);
    expect(section).toMatch(/意見/);
    const prompt = buildPrompt({
      mode: "oneshot", kind: "pick", instructions: "", material: { title: "t", excerpt: "" }, replies: [],
      previousBotText: null, maxChars: 120, persona: null, character: characterById("critic"),
    });
    expect(prompt).toContain("辛口レビュアー");
  });
});
