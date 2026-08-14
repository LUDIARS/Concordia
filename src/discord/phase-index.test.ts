import { describe, expect, it, vi } from "vitest";
import { recordPlanCardMessageId, recordQuestionCardMessageId } from "./phase-index.js";

describe("phase-index message id recording", () => {
  it("records the plan card message id into session metadata", () => {
    const mergeMetadata = vi.fn();
    recordPlanCardMessageId({ mergeMetadata }, "session-1", "msg-plan", { warn: vi.fn() });
    expect(mergeMetadata).toHaveBeenCalledWith("session-1", { discord_plan_message_id: "msg-plan" });
  });

  it("records the question card message id into session metadata", () => {
    const mergeMetadata = vi.fn();
    recordQuestionCardMessageId({ mergeMetadata }, "session-1", "msg-question", { warn: vi.fn() });
    expect(mergeMetadata).toHaveBeenCalledWith("session-1", { discord_question_message_id: "msg-question" });
  });

  it("does nothing when the message id is missing (post failed)", () => {
    const mergeMetadata = vi.fn();
    const log = { warn: vi.fn() };
    recordPlanCardMessageId({ mergeMetadata }, "session-1", null, log);
    recordQuestionCardMessageId({ mergeMetadata }, "session-1", undefined, log);
    expect(mergeMetadata).not.toHaveBeenCalled();
  });

  it("keeps an already-posted card successful when metadata recording fails", () => {
    const log = { warn: vi.fn() };
    const mergeMetadata = vi.fn(() => { throw new Error("db unavailable"); });

    expect(() => recordQuestionCardMessageId({ mergeMetadata }, "session-1", "msg-question", log)).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("db unavailable"));
  });
});
