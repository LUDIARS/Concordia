/** @implements spec/feature/task-workflow-v3.md — CC-AT-TEAM-02 multi-team selection policy */

import { describe, expect, it } from "vitest";
import type { ActioBinding } from "./actio-binding.js";
import {
  ActioTeamCandidatesError, ActioTeamSelectionError, bindingTeamCandidates, failureTeamCandidates,
  lateBoundTeam, selectActioTeam, taskTeamInScope,
} from "./actio-team-selection.js";

const BASE: ActioBinding = {
  repoPath: "E:/Document/Ars/Cernere", project: "Cernere", projectId: "Cr",
  ownerId: "actio-local", authMode: "loopback", subsidiaryId: null, teamId: null,
};
const MULTI: ActioBinding = { ...BASE, teamCandidates: ["team-a", "team-b"] };

describe("selectActioTeam", () => {
  it("leaves the binding unchanged without a request", () => {
    expect(selectActioTeam(MULTI)).toBe(MULTI);
    expect(selectActioTeam(MULTI, null)).toBe(MULTI);
    expect(selectActioTeam({ ...BASE, teamId: "team-1" }, undefined)).toEqual({ ...BASE, teamId: "team-1" });
  });

  it("uses a requested team only when it is registered", () => {
    expect(selectActioTeam(MULTI, "team-b")).toEqual({ ...MULTI, teamId: "team-b" });
    expect(selectActioTeam({ ...BASE, teamId: "team-1" }, "team-1")).toEqual({ ...BASE, teamId: "team-1" });
  });

  it("rejects unregistered teams and never overrides a fixed team", () => {
    expect(() => selectActioTeam(MULTI, "team-x")).toThrow(ActioTeamSelectionError);
    expect(() => selectActioTeam(BASE, "team-x")).toThrow("not registered");
    expect(() => selectActioTeam({ ...BASE, teamId: "team-1", teamCandidates: ["team-2"] }, "team-2"))
      .toThrow("not registered");
    try { selectActioTeam(MULTI, "team-x"); } catch (error) {
      expect(failureTeamCandidates(error)).toEqual(["team-a", "team-b"]);
    }
  });
});

describe("team scope helpers", () => {
  it("accepts team-less or candidate-team tasks through a multi-team binding", () => {
    expect(taskTeamInScope(MULTI, null)).toBe(true);
    expect(taskTeamInScope(MULTI, "team-a")).toBe(true);
    expect(taskTeamInScope(MULTI, "team-x")).toBe(false);
    expect(taskTeamInScope(BASE, "team-a")).toBe(false);
    // A team-less task belongs to the binding's single fixed team (neco 2026-10-09).
    expect(taskTeamInScope({ ...BASE, teamId: "team-1" }, null)).toBe(true);
    expect(taskTeamInScope({ ...BASE, teamId: "team-1" }, "team-1")).toBe(true);
    expect(taskTeamInScope({ ...BASE, teamId: "team-1" }, "team-2")).toBe(false);
  });

  it("late-binds only a team-less task, and only to an exactly known team", () => {
    expect(lateBoundTeam({ ...BASE, teamId: "team-1" }, null)).toBe("team-1");
    expect(lateBoundTeam({ ...BASE, teamId: "team-1" }, "team-1")).toBeNull();
    expect(lateBoundTeam(MULTI, null)).toBeNull();
    expect(lateBoundTeam(BASE, null)).toBeNull();
  });

  it("lists candidates and carries them on refusal errors only", () => {
    expect(bindingTeamCandidates(MULTI)).toEqual(["team-a", "team-b"]);
    expect(bindingTeamCandidates({ ...BASE, teamId: "team-1" })).toEqual(["team-1"]);
    expect(bindingTeamCandidates(BASE)).toEqual([]);
    const refused = new ActioTeamCandidatesError("Actio task request rejected (400)", ["team-a"]);
    expect(refused.message).toBe("Actio task request rejected (400)");
    expect(failureTeamCandidates(refused)).toEqual(["team-a"]);
    expect(failureTeamCandidates(new Error("other"))).toEqual([]);
  });
});
