import { afterEach, describe, expect, it } from "vitest";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { deliverDirectorInstruction } from "./session-instruction.js";

describe("deliverDirectorInstruction", () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
  });

  it("persists the complete instruction before publishing it live", () => {
    const calls: string[] = [];
    const events: ConcordiaEvent[] = [];
    stop = eventBus.subscribe((event) => {
      calls.push("emit");
      events.push(event);
    });

    deliverDirectorInstruction({
      sessions: {
        appendEvent: (event) => {
          calls.push("append");
          expect(event).toEqual({
            session_id: "session-1",
            ts: 123,
            kind: "inject",
            payload: { text: "approved plan body", source: "director:case-1:plan-approved" },
          });
        },
      },
      sessionId: "session-1",
      text: "approved plan body",
      source: "director:case-1:plan-approved",
      ts: 123,
    });

    expect(calls).toEqual(["append", "emit"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "session.inject",
      target_session_id: "session-1",
      text: "approved plan body",
    }));
  });
});
