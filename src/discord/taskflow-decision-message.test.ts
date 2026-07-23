import { describe, expect, it } from "vitest";
import { buildTaskflowDecisionMessage } from "./taskflow-decision-message.js";

describe("buildTaskflowDecisionMessage", () => {
  it("permits only the configured user mention", () => {
    expect(buildTaskflowDecisionMessage({
      text: "確認してください",
      mentionUserId: "123456789",
    })).toEqual(expect.objectContaining({
      content: "<@123456789> 確認してください",
      allowedMentions: { parse: [], users: ["123456789"] },
    }));
  });

  it("disables mention parsing when no user is configured", () => {
    expect(buildTaskflowDecisionMessage({
      text: "確認してください",
      mentionUserId: null,
    }).allowedMentions).toEqual({ parse: [] });
  });
});
