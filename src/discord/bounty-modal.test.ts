import { describe, expect, it } from "vitest";
import { BOUNTY_CUSTOM_ID_PREFIX, BOUNTY_REPORT_MODAL_ID, buildBountyModal, readBountyModal } from "./bounty-modal.js";

type ModalJson = {
  custom_id: string;
  title: string;
  components: Array<{ components: Array<{ custom_id: string; required?: boolean; value?: string; max_length?: number }> }>;
};

const inputs = (modal: ModalJson) => modal.components.map((row) => row.components[0]!);

describe("buildBountyModal (bug-bounty.md §3)", () => {
  it("asks for the project, what happened, the repro steps and the public name", () => {
    const modal = buildBountyModal().toJSON() as unknown as ModalJson;
    expect(modal.custom_id).toBe(BOUNTY_REPORT_MODAL_ID);
    expect(modal.custom_id.startsWith(BOUNTY_CUSTOM_ID_PREFIX)).toBe(true);
    expect(inputs(modal).map((input) => [input.custom_id, input.required])).toEqual([
      ["project", false],
      ["what_happened", true],
      ["repro_steps", false],
      ["public_name", false],
    ]);
    expect(inputs(modal).every((input) => input.value === undefined)).toBe(true);
  });

  it("prefills the chosen project and the reporter's own public name, never a Discord display name", () => {
    const modal = buildBountyModal({ project: " Cc ", publicName: "neco" }).toJSON() as unknown as ModalJson;
    const byId = new Map(inputs(modal).map((input) => [input.custom_id, input]));
    expect(byId.get("project")?.value).toBe("Cc");
    expect(byId.get("public_name")?.value).toBe("neco");
    expect(byId.get("public_name")?.max_length).toBe(32);
    expect(byId.get("what_happened")?.max_length).toBe(4000);
  });
});

describe("readBountyModal", () => {
  const fields = (values: Record<string, string>) => ({
    getTextInputValue: (id: string) => {
      if (!(id in values)) throw new Error("missing field");
      return values[id]!;
    },
  });

  it("reads the trimmed fields and treats absent optional fields as blank", () => {
    expect(readBountyModal({
      customId: BOUNTY_REPORT_MODAL_ID,
      fields: fields({ project: " Cc ", what_happened: " 壊れている " }),
    })).toEqual({ project: "Cc", what_happened: "壊れている", repro_steps: "", public_name: "" });
  });

  it("ignores a modal of another surface", () => {
    expect(readBountyModal({ customId: "consult:modal:dept_1", fields: fields({}) })).toBeNull();
  });
});
