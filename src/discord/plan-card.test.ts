import { describe, expect, it } from "vitest";
import { renderPlanCard } from "./plan-card.js";

describe("plan card", () => {
  it("binds all three decisions to the rendered plan version", () => {
    const card = renderPlanCard({
      caseId: "c1",
      version: 2,
      markdown: "# plan\n## 受け入れ条件\n- ok",
    });
    expect(card.embeds[0].data.title).toContain("v2");
    expect(card.components[0].components).toHaveLength(3);
    expect(card.components[0].components.map((component) =>
      "custom_id" in component.data ? component.data.custom_id : undefined,
    )).toEqual([
      "dirplan:approve:c1:2",
      "dirplan:revise:c1:2",
      "dirplan:discard:c1:2",
    ]);
  });
});
