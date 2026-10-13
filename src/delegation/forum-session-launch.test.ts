import { describe, expect, it } from "vitest";
import { forumLaunchProvider, forumSessionHostAccess } from "./forum-session-launch.js";

describe("forumLaunchProvider", () => {
  it("keeps Satelles for an unconfined launch", () => {
    expect(forumLaunchProvider({ targetProvider: "codex-sdk", consultConfined: false })).toBe("codex-sdk");
  });

  it("falls back to the terminal Codex lane for a confined consult", () => {
    expect(forumLaunchProvider({ targetProvider: "codex-sdk", consultConfined: true })).toBe("codex");
  });

  it("leaves other providers unchanged", () => {
    expect(forumLaunchProvider({ targetProvider: "claude", consultConfined: true })).toBe("claude");
    expect(forumLaunchProvider({ targetProvider: "codex", consultConfined: false })).toBe("codex");
  });
});

describe("forumSessionHostAccess", () => {
  it("grants the elevated sandbox to a forum template on Satelles", () => {
    expect(forumSessionHostAccess({ targetProvider: "codex-sdk", forumTag: 1, consultConfined: false })).toBe(true);
    expect(forumSessionHostAccess({ targetProvider: "codex-sdk", forumTag: true, consultConfined: false })).toBe(true);
  });

  it("never grants it to a confined consult", () => {
    expect(forumSessionHostAccess({ targetProvider: "codex-sdk", forumTag: 1, consultConfined: true })).toBe(false);
  });

  it("does not grant it to non-forum templates or other providers", () => {
    expect(forumSessionHostAccess({ targetProvider: "codex-sdk", forumTag: 0, consultConfined: false })).toBe(false);
    expect(forumSessionHostAccess({ targetProvider: "codex-sdk", forumTag: null, consultConfined: false })).toBe(false);
    expect(forumSessionHostAccess({ targetProvider: "codex", forumTag: 1, consultConfined: false })).toBe(false);
  });
});
