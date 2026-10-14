import { describe, expect, it } from "vitest";
import { publicationRewardRequest } from "./publication-reward.js";

const consultation = { id: "pc_1", subsidiary_id: "glab", requester_user_id: "111" };

describe("publicationRewardRequest (personal-ai-budget.md §4 tabula)", () => {
  it("asks for a tabula reward for a published proposal, keyed by the proposal id, to the requester", () => {
    expect(publicationRewardRequest({ id: "pub_1", status: "published", consultation_id: "pc_1" }, consultation)).toEqual({
      kind: "tabula",
      sourceRef: "pub_1",
      recipient: { subsidiaryId: "glab", platform: "discord", platformUserId: "111" },
    });
  });

  it("keeps the head-office affiliation so the budget side can skip it (CC-PBUDGET-INV-07)", () => {
    const request = publicationRewardRequest(
      { id: "pub_1", status: "published", consultation_id: "pc_1" },
      { ...consultation, subsidiary_id: null },
    );
    expect(request?.recipient.subsidiaryId).toBeNull();
  });

  it("does not ask for proposals that were not published", () => {
    for (const status of ["proposed", "declined", "withdrawn"] as const) {
      expect(publicationRewardRequest({ id: "pub_1", status, consultation_id: "pc_1" }, consultation)).toBeNull();
    }
  });

  it("does not ask when the proposal belongs to another consultation", () => {
    expect(publicationRewardRequest({ id: "pub_1", status: "published", consultation_id: "pc_2" }, consultation)).toBeNull();
  });
});
