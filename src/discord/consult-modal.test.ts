import { describe, expect, it } from "vitest";
import {
  buildConsultApprovalRow,
  buildConsultModal,
  isConsultCustomId,
  parseConsultApproval,
  readConsultModal,
} from "./consult-modal.js";

describe("consult modal", () => {
  it("asks the four intake items and pre-fills level and role from the requester notes", () => {
    const modal = buildConsultModal({
      departmentId: "dept_qa",
      departmentName: "技術相談課",
      defaults: { skill_level: "中級", role_title: "エンジニア" },
    }).toJSON();
    expect(modal.custom_id).toBe("consult:modal:dept_qa");
    expect(modal.title).toBe("技術相談課へのプライベート相談");
    const inputs = modal.components.map((row) => (row as unknown as { components: Array<Record<string, unknown>> }).components[0]!);
    expect(inputs.map((input) => input.custom_id)).toEqual(["topic", "skill_level", "role_title", "purpose"]);
    expect(inputs.map((input) => input.required)).toEqual([true, true, true, false]);
    expect(inputs[1]).toMatchObject({ value: "中級" });
    expect(inputs[2]).toMatchObject({ value: "エンジニア" });
  });

  it("reads a submission and tolerates an absent optional purpose", () => {
    const values: Record<string, string> = { topic: " 集約の切り方 ", skill_level: "初級", role_title: "学生" };
    const read = readConsultModal({
      customId: "consult:modal:dept_qa",
      fields: {
        getTextInputValue: (id: string) => {
          if (!(id in values)) throw new Error("missing field");
          return values[id]!;
        },
      },
    });
    expect(read).toEqual({
      departmentId: "dept_qa",
      intake: { topic: "集約の切り方", skill_level: "初級", role_title: "学生", purpose: "" },
    });
    expect(readConsultModal({ customId: "qothm:1", fields: { getTextInputValue: () => "" } })).toBeNull();
  });

  it("round-trips the approval button id", () => {
    const row = buildConsultApprovalRow("pc_1").toJSON();
    const customId = (row.components[0] as { custom_id: string }).custom_id;
    expect(isConsultCustomId(customId)).toBe(true);
    expect(parseConsultApproval(customId)).toBe("pc_1");
    expect(parseConsultApproval("consult:modal:x")).toBeNull();
  });
});
