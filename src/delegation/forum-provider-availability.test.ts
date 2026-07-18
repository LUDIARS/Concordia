import { describe, expect, it } from "vitest";
import { pickAvailableForumProvider } from "./forum-provider-availability.js";

describe("pickAvailableForumProvider", () => {
  it("picks the provider with more weekly quota remaining", () => {
    expect(pickAvailableForumProvider({
      codexRate: { usedWeekly: 10 },
      claudeUsage: { sevenDay: { utilization: 90 } },
    })).toBe("codex");
    expect(pickAvailableForumProvider({
      codexRate: { usedWeekly: 90 },
      claudeUsage: { sevenDay: { utilization: 10 } },
    })).toBe("claude");
  });

  it("defaults to claude on a tie", () => {
    expect(pickAvailableForumProvider({
      codexRate: { usedWeekly: 50 },
      claudeUsage: { sevenDay: { utilization: 50 } },
    })).toBe("claude");
  });

  it("falls back to claude when codex usage is unavailable", () => {
    expect(pickAvailableForumProvider({
      codexRate: null,
      claudeUsage: { sevenDay: { utilization: 90 } },
    })).toBe("claude");
    expect(pickAvailableForumProvider({
      codexRate: { usedWeekly: null },
      claudeUsage: null,
    })).toBe("claude");
  });

  it("falls back to codex when claude usage is unavailable but codex is known", () => {
    expect(pickAvailableForumProvider({
      codexRate: { usedWeekly: 10 },
      claudeUsage: null,
    })).toBe("codex");
    expect(pickAvailableForumProvider({
      codexRate: { usedWeekly: 10 },
      claudeUsage: { sevenDay: null },
    })).toBe("codex");
  });

  it("defaults to claude when neither is available", () => {
    expect(pickAvailableForumProvider({ codexRate: null, claudeUsage: null })).toBe("claude");
  });
});
