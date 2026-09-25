/** @implements spec/feature/task-workflow-v3.md — Configuration and access */

import { describe, expect, it } from "vitest";
import { readActioBindings, repositoryKey } from "./actio-binding.js";

const HQ = {
  repoPath: "E:/Document/Ars/Concordia",
  project: "Concordia",
  projectId: "project-1",
  ownerId: "owner-1",
  tokenEnv: "CONCORDIA_ACTIO_TASK_TOKEN",
  subsidiaryId: null,
  teamId: null,
};

const env = (bindings: unknown): NodeJS.ProcessEnv =>
  ({ CONCORDIA_ACTIO_TASK_BINDINGS: JSON.stringify(bindings) }) as NodeJS.ProcessEnv;

describe("readActioBindings", () => {
  const local = { ...HQ, ownerId: "actio-local", authMode: "loopback", tokenEnv: undefined };

  it("accepts explicit personal loopback identity without manufacturing a bearer token", () => {
    expect(readActioBindings(env([local]))[0]).toMatchObject({ authMode: "loopback", ownerId: "actio-local" });
    for (const patch of [{ ownerId: "owner-1" }, { teamId: "team-1" },
      { subsidiaryId: "sub-1" }, { tokenEnv: "TOKEN" }]) {
      expect(() => readActioBindings(env([{ ...local, ...patch }]))).toThrow("Invalid CONCORDIA_ACTIO_TASK_BINDINGS");
    }
    expect(() => readActioBindings(env([{ ...HQ, tokenEnv: undefined }]))).toThrow("Invalid CONCORDIA_ACTIO_TASK_BINDINGS");
  });

  it("loads encrypted Excubitor runtime bindings, with explicit env taking precedence", () => {
    const encrypted = { EXCUBITOR_SERVICE_CONFIG_JSON: JSON.stringify({ actioTaskBindings: [local], unrelated: true }) };
    expect(readActioBindings(encrypted)[0]?.authMode).toBe("loopback");
    expect(readActioBindings({ ...encrypted, ...env([HQ]) })).toEqual([HQ]);
    expect(() => readActioBindings({ ...encrypted, CONCORDIA_ACTIO_TASK_BINDINGS: "" }))
      .toThrow("CONCORDIA_ACTIO_TASK_BINDINGS is required and must be JSON");
    for (const value of ["{", "null", "[]"]) {
      expect(() => readActioBindings({ EXCUBITOR_SERVICE_CONFIG_JSON: value })).toThrow();
    }
  });

  it("accepts a headquarters binding and defaults the organization to null", () => {
    const [binding] = readActioBindings(env([{
      repoPath: HQ.repoPath, project: HQ.project, projectId: HQ.projectId,
      ownerId: HQ.ownerId, tokenEnv: HQ.tokenEnv,
    }]));

    expect(binding).toEqual(HQ);
  });

  it("allows absent or empty bindings for discovery but rejects malformed explicit configuration", () => {
    expect(readActioBindings({})).toEqual([]);
    expect(readActioBindings(env([]))).toEqual([]);
    expect(readActioBindings({ EXCUBITOR_SERVICE_CONFIG_JSON: "{}" })).toEqual([]);
    expect(readActioBindings({ EXCUBITOR_SERVICE_CONFIG_JSON: '{"actioTaskBindings":[]}' })).toEqual([]);
    expect(() => readActioBindings({ CONCORDIA_ACTIO_TASK_BINDINGS: "{" } as NodeJS.ProcessEnv))
      .toThrow("CONCORDIA_ACTIO_TASK_BINDINGS is required and must be JSON");
  });

  it("rejects unknown keys and an anonymous owner", () => {
    expect(() => readActioBindings(env([{ ...HQ, extra: 1 }]))).toThrow("Invalid CONCORDIA_ACTIO_TASK_BINDINGS");
    expect(() => readActioBindings(env([{ ...HQ, ownerId: "anonymous" }])))
      .toThrow("Invalid CONCORDIA_ACTIO_TASK_BINDINGS");
  });

  /** A token value in the configuration would be persisted with it; only the env name may appear. */
  it("rejects a tokenEnv that is not an environment variable name", () => {
    expect(() => readActioBindings(env([{ ...HQ, tokenEnv: "actio-token" }])))
      .toThrow("Invalid CONCORDIA_ACTIO_TASK_BINDINGS");
  });

  it("requires an absolute repository path", () => {
    expect(() => readActioBindings(env([{ ...HQ, repoPath: "Concordia" }])))
      .toThrow("Actio binding repoPath must be absolute");
  });

  it("requires a team for a subsidiary binding", () => {
    expect(() => readActioBindings(env([{ ...HQ, subsidiaryId: "sub-1", teamId: null }])))
      .toThrow("Subsidiary Actio binding requires teamId");
  });

  /** Two bindings for the same project/owner/team make the repository lookup ambiguous. */
  it("rejects a duplicated project ownership identity", () => {
    expect(() => readActioBindings(env([HQ, { ...HQ, repoPath: "E:/Document/Ars/Other", project: "Other" }])))
      .toThrow("Duplicate Actio project ownership binding");
  });

  it("keeps bindings that differ by team apart", () => {
    expect(readActioBindings(env([
      HQ,
      { ...HQ, repoPath: "E:/Document/Ars/Other", project: "Other", subsidiaryId: "sub-1", teamId: "team-1" },
    ]))).toHaveLength(2);
  });
});

describe("repositoryKey", () => {
  it("compares Windows paths case-insensitively with forward slashes", () => {
    expect(repositoryKey("E:\\Document\\Ars\\Concordia\\"))
      .toBe(repositoryKey("e:/document/ars/concordia"));
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(repositoryKey("/srv/Concordia/")).toBe("/srv/Concordia");
    expect(repositoryKey("/srv/concordia")).not.toBe(repositoryKey("/srv/Concordia"));
  });

  it("normalizes traversal segments so a worktree cannot alias another project", () => {
    expect(repositoryKey("/srv/Concordia/../Ergo")).toBe("/srv/Ergo");
  });
});
