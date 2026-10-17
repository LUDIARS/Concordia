import { describe, expect, it } from "vitest";
import { observationCard } from "./card.js";
import { applyObservation, initialObservation } from "./state.js";

describe("cloud observation presentation", () => {
  it("neutralizes mentions and credentials and does not embed remote URLs", () => {
    const state = applyObservation(initialObservation(), { id: "e", sequence: 1, kind: "progress",
      message: "@everyone Bearer test-only-value https://example.test/private" }, 0);
    const card = observationCard(state, 200000);
    expect(card.allowedMentions).toEqual({ parse: [] });
    expect(card.content).not.toContain("test-only-value");
    expect(card.content).not.toContain("https://");
    expect(card.content).not.toContain("@everyone");
    expect(card.content).toContain("通信途絶（成否不明）");
  });
  it("shows unanswered questions without authorizing automatic resumption", () => {
    const state = applyObservation(initialObservation(), { id: "e", sequence: 1, kind: "question",
      questionId: "height", message: "階数を指定してください" }, 0);
    expect(observationCard(state, 1000).content).toContain("確認事項 height");
    expect(observationCard(state, 1000).content).toContain("再開しません");
  });
});
