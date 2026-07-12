import { describe, expect, it } from "vitest";
import { buildSlackConsultationBody } from "./ingress-chat.js";

describe("Slack consultation ingress", () => {
  it("binds the mirrored post to its relay session", () => {
    expect(buildSlackConsultationBody("hello", "U123", "session-1")).toMatchObject({
      channel: "consultation",
      session_id: "session-1",
      text: "hello",
      author_label: "U123",
      metadata: { source: "slack", slack_user_id: "U123" },
    });
  });
});
