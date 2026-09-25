import { describe, expect, it, vi } from "vitest";
import { createActioBindingReader, mergeActioProjectBindings } from "./actio-project-binding.js";
import { LOCAL_ACTIO_ACCESS, type ActioProject } from "./actio-projects.js";
import { ActioTaskStore } from "./actio-store.js";

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

  it("preserves explicit destinations and never assigns a team to the local personal owner", () => {
    expect(mergeActioProjectBindings([explicit], [repo], [project])).toEqual([explicit]);
    expect(mergeActioProjectBindings([], [repo], [{ ...project, teamIds: ["team"] }])).toEqual([]);
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
    expect(registered).not.toHaveBeenCalled();
    const local = createActioBindingReader({ configured: () => [], repositories: () => [repo], registered });
    await expect(local()).rejects.toThrow("identity mismatch");
  });
});
