import { describe, expect, it } from "vitest";
import { choosePatrolProvider } from "./patrol-model-policy.js";

describe("patrol weekly remaining quota selection", () => {
  it("randomizes when both have at least 50 percent, regardless of which has more", () => {
    expect(choosePatrolProvider({ claude: 50, codex: 90 }, 0)).toBe("claude");
    expect(choosePatrolProvider({ claude: 90, codex: 50 }, 0.5)).toBe("codex");
  });
  it("selects the only provider with at least 25 percent", () => {
    expect(choosePatrolProvider({ claude: 25, codex: 24 }, 0.9)).toBe("claude");
    expect(choosePatrolProvider({ claude: 0, codex: 25 }, 0)).toBe("codex");
  });
  it("otherwise uses the larger balance, including when both are below 25", () => {
    expect(choosePatrolProvider({ claude: 45, codex: 49 }, 0)).toBe("codex");
    expect(choosePatrolProvider({ claude: 20, codex: 10 }, 0.9)).toBe("claude");
    expect(choosePatrolProvider({ claude: 10, codex: 20 }, 0)).toBe("codex");
  });
  it("breaks equal low balances randomly and never treats unknown quota as available", () => {
    expect(choosePatrolProvider({ claude: 10, codex: 10 }, 0.8)).toBe("codex");
    for (const value of [null, NaN, -1, 101]) {
      expect(() => choosePatrolProvider({ claude: value, codex: 80 }, 0)).toThrow("patrol_quota_unavailable");
    }
  });
});
