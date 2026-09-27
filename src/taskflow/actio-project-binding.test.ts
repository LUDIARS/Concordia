import { describe, expect, it, vi } from "vitest";
import { createActioBindingReader, mergeActioProjectBindings } from "./actio-project-binding.js";
import { LOCAL_ACTIO_ACCESS, type ActioProject } from "./actio-projects.js";
import { ActioTaskStore } from "./actio-store.js";
import type { ActioBindingScope } from "./actio-binding-scope.js";
import * as repositoryIdentity from "./repository-identity.js";

const repo = { code: "El", project: "Elegantia", repo_path: "E:/Document/Ars/Elegantia" };
const project: ActioProject = { code: "El", name: "Elegantia", teamIds: [] };
const explicit = { ...LOCAL_ACTIO_ACCESS, repoPath: repo.repo_path, project: repo.project, projectId: "old-id" };

describe("Actio registration resolution", () => {
  it("uses exact registered codes without an additional repository binding", () => {
    expect(mergeActioProjectBindings([], [repo], [project])).toEqual([
      { ...explicit, projectId: "El" },
    ]);
    expect(mergeActioProjectBindings([], [repo], [{ ...project, code: "el" }])).toEqual([]);
    expect(mergeActioProjectBindings([], [repo], [])).toEqual([]);
  });

  it("preserves explicit destinations and the registered team scope", () => {
    expect(mergeActioProjectBindings([explicit], [repo], [project])).toEqual([explicit]);
    expect(mergeActioProjectBindings([], [repo], [{ ...project, teamIds: ["team"] }])).toEqual([
      { ...explicit, projectId: "El", teamId: "team" },
    ]);
    expect(() => mergeActioProjectBindings([], [repo], [{ ...project, teamIds: ["a", "b"] }]))
      .toThrow("team registration is ambiguous");
  });

  it("rejects ambiguous registrations and duplicate repository identities", () => {
    expect(() => mergeActioProjectBindings([], [repo], [project, project])).toThrow("ambiguous");
    expect(() => mergeActioProjectBindings([], [repo, { ...repo, code: "Other" }],
      [project, { ...project, code: "Other" }])).toThrow("ambiguous");
    expect(() => mergeActioProjectBindings([], [repo, { ...repo, repo_path: "E:/other" }], [project]))
      .toThrow("Duplicate");
  });

  it("observes additions and removals on the next store lookup and preserves subsidiary scope", async () => {
    const registered = vi.fn<() => Promise<ActioProject[]>>().mockResolvedValue([]);
    const read = createActioBindingReader({ configured: () => [], repositories: () => [repo], registered });
    const store = new ActioTaskStore(read, {} as never, {} as never);
    await expect(store.binding(repo.repo_path, null)).rejects.toThrow("binding missing");
    registered.mockResolvedValue([project]);
    await expect(store.binding(repo.repo_path, null)).resolves.toMatchObject({ projectId: "El", ownerId: "actio-local" });
    await expect(store.binding(repo.repo_path, "subsidiary")).rejects.toThrow("binding missing");
    registered.mockResolvedValue([]);
    await expect(store.binding(repo.repo_path, null)).rejects.toThrow("binding missing");
  });

  it("does not downgrade a bearer deployment or swallow a discovery failure", async () => {
    const registered = vi.fn().mockRejectedValue(new Error("Actio task identity mismatch"));
    const bearer = { ...explicit, authMode: "bearer" as const, ownerId: "owner", tokenEnv: "ACTIO_TOKEN" };
    const read = createActioBindingReader({ configured: () => [bearer], repositories: () => [repo], registered });
    expect(await read()).toEqual([bearer]);
    expect(await read({ project: "unconfigured" })).toEqual([]);
    expect(registered).not.toHaveBeenCalled();
    const local = createActioBindingReader({ configured: () => [], repositories: () => [repo], registered });
    await expect(local()).rejects.toThrow("identity mismatch");
  });

  it.each<ActioBindingScope>([
    { project: "ELEGANTIA" }, { repoPath: "e:\\document\\ars\\elegantia\\" },
  ])("isolates selected registration from unrelated team ambiguity: %o", async (scope) => {
    const other = { code: "Other", project: "Other", repo_path: "E:/Other" };
    const read = createActioBindingReader({
      configured: () => [], repositories: () => [other, repo],
      registered: async () => [{ ...project, code: "Other", teamIds: ["a", "b"] }, { ...project, teamIds: ["team"] }],
    });
    await expect(read(scope)).resolves.toEqual([{ ...explicit, projectId: "El", teamId: "team" }]);
    await expect(read({ project: "Other" })).rejects.toThrow("team registration is ambiguous");
    await expect(read()).rejects.toThrow("team registration is ambiguous");
  });

  it("does not reopen discovery when an explicit binding has a different project label", async () => {
    const configured = { ...explicit, project: "Configured name" };
    const read = createActioBindingReader({
      configured: () => [configured], repositories: () => [repo],
      registered: async () => [{ ...project, teamIds: ["a", "b"] }],
    });
    await expect(read({ project: repo.project })).resolves.toEqual([]);
    await expect(read({ project: configured.project })).resolves.toEqual([configured]);
    await expect(read({ repoPath: repo.repo_path })).resolves.toEqual([configured]);
  });

  it("keeps duplicate registrations invalid within the selected project", async () => {
    const read = createActioBindingReader({
      configured: () => [], repositories: () => [repo], registered: async () => [project, project],
    });
    await expect(read({ project: repo.project })).rejects.toThrow("registration is ambiguous");
  });

  it("selects the canonical repository before the reader validates bindings", async () => {
    const resolve = vi.spyOn(repositoryIdentity, "mainRepositoryKey").mockResolvedValue("e:/document/ars/elegantia");
    try {
      const reader = vi.fn(async (_scope?: ActioBindingScope) => [explicit]);
      const store = new ActioTaskStore(reader, {} as never, {} as never);
      await expect(store.binding("E:/Document/Ars/.wt-elegantia", null)).resolves.toEqual(explicit);
      expect(reader).toHaveBeenCalledWith({ repoPath: "e:/document/ars/elegantia" });
      expect(resolve).toHaveBeenCalledWith("E:/Document/Ars/.wt-elegantia");
    } finally { resolve.mockRestore(); }
  });
});
