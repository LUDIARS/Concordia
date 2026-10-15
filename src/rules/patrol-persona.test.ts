import { describe, expect, it } from "vitest";
import {
  PATROL_PERSONA_POOL,
  fallbackPersona,
  personaOfChatMetadata,
  personaOfDecision,
  personaUsername,
  sanitizePersonaName,
  splitPersonaLine,
  withPersonaDecision,
} from "./patrol-persona.js";

describe("patrol persona", () => {
  it("accepts short invented names and rejects mentions, URLs and Discord-reserved words", () => {
    expect(sanitizePersonaName(" 「速水 翻」 ")).toBe("速水 翻");
    expect(sanitizePersonaName("a")).toBeNull();
    expect(sanitizePersonaName("x".repeat(17))).toBeNull();
    for (const bad of ["@everyone", "here 太郎", "https://x", "discord 君", "a#b", "名`前"]) {
      expect(sanitizePersonaName(bad)).toBeNull();
    }
  });

  it("splits the name line from the body", () => {
    expect(splitPersonaLine("\n名前：噂坂 聞\n本文です")).toEqual({ name: "噂坂 聞", body: "本文です" });
    expect(splitPersonaLine("本文だけ")).toEqual({ name: null, body: "本文だけ" });
  });

  it("picks a deterministic fallback from the pool", () => {
    expect(fallbackPersona("same")).toBe(fallbackPersona("same"));
    expect(PATROL_PERSONA_POOL).toContain(fallbackPersona("other"));
    expect(PATROL_PERSONA_POOL.every((n) => sanitizePersonaName(n) === n)).toBe(true);
  });

  it("round-trips through the run decision and chat metadata", () => {
    const d = withPersonaDecision(JSON.stringify({ candidateCount: 3 }), "拾井 種");
    expect(JSON.parse(d)).toEqual({ candidateCount: 3, persona: "拾井 種" });
    expect(personaOfDecision(d)).toBe("拾井 種");
    expect(personaOfDecision(withPersonaDecision(null, "旬田 摘"))).toBe("旬田 摘");
    expect(personaOfDecision("not json")).toBeNull();
    expect(personaOfChatMetadata(JSON.stringify({ patrol_persona: "旬田 摘" }))).toBe("旬田 摘");
    expect(personaOfChatMetadata(null)).toBeNull();
    expect(personaUsername("旬田 摘")).toBe("旬田 摘 (巡回)");
  });
});
