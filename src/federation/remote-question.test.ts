import { describe, expect, it } from "vitest";
import { hqEchoUsername, toAnswerBody, toEgressQuestion } from "./remote-question.js";

describe("SPEC-FED-SITE-FORUM-PARITY: site question relay shapes", () => {
  it("normalizes old and new option forms within protocol limits", () => {
    expect(toEgressQuestion({
      question_id: 7, question: "  どれ？ ", options: ["A案", { label: "B案", description: "説明" }, { label: " " }], multi_select: true,
    })).toEqual({ question_id: 7, prompt: "どれ？", options: [{ label: "A案" }, { label: "B案", description: "説明" }], multi_select: true });
    const long = toEgressQuestion({ question_id: 1, question: "q", options: Array.from({ length: 30 }, (_, i) => `x${i}`.repeat(60)) });
    expect(long?.options).toHaveLength(25);
    expect(Array.from(long!.options[0]!.label)).toHaveLength(100);
  });

  it("does not relay plan approvals or empty questions", () => {
    expect(toEgressQuestion({ kind: "plan_approval", question_id: 1, question: "承認", options: [] })).toBeNull();
    expect(toEgressQuestion({ question_id: 1, question: "  ", options: [] })).toBeNull();
    expect(toEgressQuestion({ question_id: 0, question: "q", options: [] })).toBeNull();
  });

  it("answers single picks by index and several picks as a multi answer", () => {
    expect(toAnswerBody(3, [1])).toEqual({ question_id: 3, answer_index: 1 });
    expect(toAnswerBody(3, [0, 2])).toEqual({ question_id: 3, answer_indices: [0, 2] });
  });

  it("labels HQ replies shown on the site surface", () => {
    expect(hqEchoUsername("neco")).toBe("neco (本社)");
    expect(hqEchoUsername(" ")).toBe("本社の利用者 (本社)");
  });
});

describe("SPEC-FED-SITE-FORUM-PARITY: mention only on the launching side", () => {
  it("mentions the HQ requester only when the site asks and HQ launched the thread", async () => {
    const { requesterMentionFor } = await import("./remote-thread-registry.js");
    const hqLaunched = { guildId: "1", siteId: "melpot", at: 1, requesterId: "905235114026467350" };
    const mirrored = { guildId: "1", siteId: "melpot", at: 1 };
    expect(requesterMentionFor(hqLaunched, { mention_requester: true })).toBe("905235114026467350");
    expect(requesterMentionFor(hqLaunched, {})).toBeUndefined();
    expect(requesterMentionFor(mirrored, { mention_requester: true })).toBeUndefined();
    expect(requesterMentionFor(null, { mention_requester: true })).toBeUndefined();
  });
});
