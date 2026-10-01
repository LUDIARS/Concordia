import { describe, expect, it } from "vitest";
import { parseSkillTier, skillLevelGuidance } from "./skill-level.js";

describe("parseSkillTier", () => {
  it("3 段階の語を読む", () => {
    expect(parseSkillTier("初級")).toBe("beginner");
    expect(parseSkillTier("中級くらい")).toBe("intermediate");
    expect(parseSkillTier("上級 (シニア)")).toBe("advanced");
  });

  it("段階の語が無い・混ざるときは決めない", () => {
    expect(parseSkillTier("経験 3 年")).toBeNull();
    expect(parseSkillTier("初級〜中級")).toBeNull();
  });
});

describe("skillLevelGuidance", () => {
  it("段階が読めればその指示だけを返す", () => {
    expect(skillLevelGuidance("初級")).toEqual([expect.stringContaining("小学五年生でわかるように")]);
    expect(skillLevelGuidance("上級").join("\n")).toContain("シニアクラスとして扱う");
  });

  it("読めなければ 3 段階の定義を並べて当てはめさせる", () => {
    const lines = skillLevelGuidance("経験 3 年").join("\n");
    expect(lines).toContain("小学五年生");
    expect(lines).toContain("噛み砕いて");
    expect(lines).toContain("シニアクラスとして扱う");
  });
});
