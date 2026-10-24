/** @implements CC-TASK-LINKED-FOLLOWUP — v3 以外の Actio タスクを指示参照として受け入れる範囲 */

import { describe, expect, it } from "vitest";
import type { ActioBinding } from "./actio-binding.js";
import { isReferenceInScope } from "./actio-reference-scope.js";

const BINDING: ActioBinding = {
  repoPath: "E:/Document/Ars/Actio", project: "Actio", projectId: "At",
  ownerId: "actio-local", subsidiaryId: null, teamId: "team-1", authMode: "loopback",
} as ActioBinding;

const legacy = { projectId: "At", ownerId: "actio-local", teamId: null, source: "cc-taskmd" };

describe("isReferenceInScope", () => {
  it("accepts a task of the same project and owner without a team", () => {
    expect(isReferenceInScope(BINDING, legacy)).toBe(true);
  });

  it("accepts a task in the bound team", () => {
    expect(isReferenceInScope(BINDING, { ...legacy, teamId: "team-1" })).toBe(true);
  });

  it("does not decide the scope by source (cc-command, Memoria import, manual input)", () => {
    expect(isReferenceInScope(BINDING, { ...legacy, source: "cc-command", teamId: "team-1" })).toBe(true);
    expect(isReferenceInScope(BINDING, { ...legacy, source: "memoria-import" })).toBe(true);
    expect(isReferenceInScope(BINDING, { ...legacy, source: null })).toBe(true);
  });

  it("accepts a task of another registered team when the binding is team-less (multi-team project)", () => {
    const multi = { ...BINDING, teamId: null, teamCandidates: ["team-1", "team-mn"] };
    expect(isReferenceInScope(multi, { ...legacy, teamId: "team-mn" })).toBe(true);
    expect(isReferenceInScope(multi, { ...legacy, teamId: "team-other" })).toBe(false);
  });

  it("rejects other projects, other owners and other teams", () => {
    expect(isReferenceInScope(BINDING, { ...legacy, projectId: "KD" })).toBe(false);
    expect(isReferenceInScope(BINDING, { ...legacy, projectId: null })).toBe(false);
    expect(isReferenceInScope(BINDING, { ...legacy, ownerId: "someone-else" })).toBe(false);
    expect(isReferenceInScope(BINDING, { ...legacy, teamId: "team-2" })).toBe(false);
  });
});
