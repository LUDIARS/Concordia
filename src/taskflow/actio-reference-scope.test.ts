/** @implements CC-TASK-LINKED-FOLLOWUP — 旧来タスク (cc-taskmd) を指示参照として受け入れる範囲 */

import { describe, expect, it } from "vitest";
import type { ActioBinding } from "./actio-binding.js";
import { isLegacyReferenceInScope } from "./actio-reference-scope.js";

const BINDING: ActioBinding = {
  repoPath: "E:/Document/Ars/Actio", project: "Actio", projectId: "At",
  ownerId: "actio-local", subsidiaryId: null, teamId: "team-1", authMode: "loopback",
} as ActioBinding;

const legacy = { projectId: "At", ownerId: "actio-local", teamId: null, source: "cc-taskmd" };

describe("isLegacyReferenceInScope", () => {
  it("accepts a cc-taskmd task of the same project and owner without a team", () => {
    expect(isLegacyReferenceInScope(BINDING, legacy)).toBe(true);
  });

  it("accepts a cc-taskmd task in the bound team", () => {
    expect(isLegacyReferenceInScope(BINDING, { ...legacy, teamId: "team-1" })).toBe(true);
  });

  it("rejects other sources, other projects, other owners and other teams", () => {
    expect(isLegacyReferenceInScope(BINDING, { ...legacy, source: "manual" })).toBe(false);
    expect(isLegacyReferenceInScope(BINDING, { ...legacy, source: null })).toBe(false);
    expect(isLegacyReferenceInScope(BINDING, { ...legacy, projectId: "KD" })).toBe(false);
    expect(isLegacyReferenceInScope(BINDING, { ...legacy, ownerId: "someone-else" })).toBe(false);
    expect(isLegacyReferenceInScope(BINDING, { ...legacy, teamId: "team-2" })).toBe(false);
  });

  it("does not treat a v3 workflow task as a legacy reference", () => {
    expect(isLegacyReferenceInScope(BINDING, { ...legacy, source: "concordia.taskflow.v3" })).toBe(false);
  });
});
