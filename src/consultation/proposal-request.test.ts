import { describe, expect, it } from "vitest";
import { buildProposalRequest } from "./proposal-request.js";

describe("buildProposalRequest", () => {
  it("asks for a rewritten summary and names the session and endpoint", () => {
    const text = buildProposalRequest({ sessionId: "sess-1", concordiaUrl: "http://127.0.0.1:11111/" });
    expect(text).toContain("書き直した要約");
    expect(text).toContain("会話を転載しない");
    expect(text).toContain("POST http://127.0.0.1:11111/v1/consultations/proposals");
    expect(text).toContain("\"session_id\":\"sess-1\"");
  });
});
