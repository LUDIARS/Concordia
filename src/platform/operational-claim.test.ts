import { describe, expect, it } from "vitest";
import { renderOperationalClaimMessage, type OperationalClaimEvent } from "./operational-claim.js";

describe("renderOperationalClaimMessage", () => {
  it("開始時は対象・branch・note・競合件数を表示する", () => {
    const event: OperationalClaimEvent = {
      type: "operational.claim.opened",
      target_session_id: "s1",
      claim_kind: "testing",
      claim_id: 10,
      resource: "concordia",
      branch: "feat/claim-posts",
      note: "restart check",
      conflict_session_ids: ["s2", "s3"],
      started_at: 100,
      ts: 100,
    };

    expect(renderOperationalClaimMessage(event)).toBe([
      "📣 [testing claim] を開始",
      "対象: `concordia`",
      "ブランチ: `feat/claim-posts`",
      "内容: restart check",
      "⚠️ 競合中の session: 2 件",
    ].join("\n"));
  });

  it("解放時は競合表示を持たない", () => {
    const event: OperationalClaimEvent = {
      type: "operational.claim.released",
      target_session_id: "s1",
      claim_kind: "testing",
      claim_id: 10,
      resource: "concordia",
      branch: null,
      note: "",
      started_at: 100,
      ts: 110,
    };

    expect(renderOperationalClaimMessage(event)).toBe([
      "✅ [testing claim] を解放",
      "対象: `concordia`",
    ].join("\n"));
  });
});
