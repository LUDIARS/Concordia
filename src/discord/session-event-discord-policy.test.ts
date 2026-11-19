import { describe, expect, it } from "vitest";
import { isDiscordSilentEvent } from "./session-event-discord-policy.js";

describe("session event Discord policy", () => {
  it("does not post the stall nudge notice to Discord", () => {
    expect(isDiscordSilentEvent("session.stall_nudged")).toBe(true);
  });

  it("keeps posting the other session events", () => {
    for (const type of [
      "question.posted",
      "question.answered",
      "question.resolved",
      "session.permission_request",
      "session.human_todos_changed",
      "session.inject",
      "session.event",
    ]) {
      expect(isDiscordSilentEvent(type)).toBe(false);
    }
  });
});
