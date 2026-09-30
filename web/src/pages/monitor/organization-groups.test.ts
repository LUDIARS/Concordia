import { describe, expect, it } from "vitest";
import { groupSessionsByDepartment, UNASSIGNED_LABEL } from "./organization-groups.js";

const departments = [
  { id: "ops", name: "運用部", sort_order: 2, archived: false, is_default: false },
  { id: "general", name: "総務", sort_order: 0, archived: false, is_default: true },
  { id: "qa", name: "技術相談課", sort_order: 1, archived: false, is_default: false },
  { id: "old", name: "旧部", sort_order: 3, archived: true, is_default: false },
  { id: "gone", name: "消えた部", sort_order: 4, archived: true, is_default: false },
];

describe("groupSessionsByDepartment", () => {
  it("orders departments, keeps empty active ones and puts unassigned last", () => {
    const groups = groupSessionsByDepartment([
      { id: "s1", department_id: "qa" },
      { id: "s2", department_id: null },
      { id: "s3", department_id: "general" },
      { id: "s4", department_id: "old" },
      { id: "s5", department_id: "unknown" },
    ], departments);

    expect(groups.map((group) => group.label)).toEqual(["総務", "技術相談課", "運用部", "旧部 (廃止)", UNASSIGNED_LABEL]);
    expect(groups.find((group) => group.key === "ops")?.sessions).toEqual([]);
    expect(groups.find((group) => group.key === "unassigned")?.sessions.map((s) => s.id)).toEqual(["s2", "s5"]);
  });

  it("shows only the unassigned section when there are no departments", () => {
    expect(groupSessionsByDepartment([{ id: "s1" }], [])).toEqual([
      { key: "unassigned", department: null, label: UNASSIGNED_LABEL, sessions: [{ id: "s1" }] },
    ]);
  });

  it("omits the unassigned section when every session belongs to a department", () => {
    const groups = groupSessionsByDepartment([{ id: "s1", department_id: "general" }], departments);
    expect(groups.map((group) => group.key)).toEqual(["general", "qa", "ops"]);
  });
});
