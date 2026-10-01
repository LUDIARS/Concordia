import { describe, expect, it } from "vitest";
import { managementCard, parseManagementButton, type DeliveryCard } from "./management.js";

const item: DeliveryCard = {
  id: "0f3c2d1e-1111-4222-8333-444455556666", mission_id: "m1", request_key: "r1", kind: "spec_change",
  project_code: "KD", target_key: "variant/v1", purpose: "仕様を直す", completion_criteria: "Pf に反映",
  evidence_seqs: [1], rationale: "意見が重なった", state: "waiting_human", attached_to: null, session_id: null,
  spawn_id: null, launch_deadline_at: null, outcome_summary: null, outcome_refs: [], human_note: null, error: null,
  created_at: 1, updated_at: 1, revision: 1, delivered_revision: 0, discord_message_id: null,
  mission_name: "CDGD", actions: ["approve", "reject"],
};

describe("management Discord card", () => {
  it("shows the state, the AI origin notice and only the allowed buttons", () => {
    const card = managementCard(item);
    expect(card.content).toContain("人間の判断待ち");
    expect(card.content).toContain("AI (dots) の判断");
    expect(card.allowedMentions).toEqual({ parse: [] });
    const ids = card.components[0]!.components.map((b) => (b.toJSON() as { custom_id: string }).custom_id);
    expect(ids).toEqual([`mgmt:${item.id}:approve`, `mgmt:${item.id}:reject`]);
  });

  it("drops the button row when no action is allowed", () => {
    expect(managementCard({ ...item, state: "dispatched", actions: [] }).components).toEqual([]);
  });

  it("parses only known actions", () => {
    expect(parseManagementButton(`mgmt:${item.id}:accept`)).toEqual({ id: item.id, action: "accept" });
    expect(parseManagementButton(`mgmt:${item.id}:delete`)).toBeNull();
    expect(parseManagementButton("chore:x:ok")).toBeNull();
  });
});
