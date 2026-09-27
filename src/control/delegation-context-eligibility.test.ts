import { describe, expect, it, vi } from "vitest";
import { allowDelegationDomainPreamble } from "./delegation-context-eligibility.js";
import { EXPLICIT_CONTEXT_BINDING_KEY, HUMAN_CONVERSATION_KEY } from "./inject-context-presence.js";

const session = { id: "s", status: "active", repo_path: "E:/repo", repo_origin: "org/repo", branch: "feat/x", target_project: "E:/repo",
  metadata: JSON.stringify({ [HUMAN_CONVERSATION_KEY]: true, [EXPLICIT_CONTEXT_BINDING_KEY]: {
    repoPath: "E:/repo", repoOrigin: "org/repo", branch: "feat/x", projectCode: "R",
  } }) };

describe("delegation context eligibility", () => {
  it("requires current parent, DDD, matching target, and a verified An project ID", async () => {
    const findSession = vi.fn(() => session);
    const deps = { sessions: { findSession }, projectCodes: { list: () => [{ code: "R", ddd_enabled: 1 }] },
      resolveLinks: vi.fn(async () => ({ praeforma: "", anatomia: "http://an/api/projects/r/domains", anatomiaProjectId: "r", anatomiaBaseUrl: "http://an" })) };
    expect(await allowDelegationDomainPreamble(deps as never, "s", "E:/repo"))
      .toEqual(expect.objectContaining({ projectId: "r", baseUrl: "http://an" }));
    expect(await allowDelegationDomainPreamble(deps as never, "s", "E:/other")).toBeNull();
    deps.resolveLinks.mockResolvedValue({ praeforma: "http://pf", anatomia: "", anatomiaProjectId: "", anatomiaBaseUrl: "" });
    expect(await allowDelegationDomainPreamble(deps as never, "s", "E:/repo")).toBeNull();
    expect(await allowDelegationDomainPreamble({ ...deps,
      projectCodes: { list: () => [{ code: "R", ddd_enabled: 0 }] },
      resolveLinks: async () => ({ praeforma: "", anatomia: "http://an", anatomiaProjectId: "r", anatomiaBaseUrl: "http://an" }),
    } as never, "s", "E:/repo")).toBeNull();
  });

  it("accepts another worktree of the same Git repository and drops a stale bind", async () => {
    let current = session;
    let release!: (value: { praeforma: string; anatomia: string; anatomiaProjectId: string; anatomiaBaseUrl: string }) => void;
    const links = new Promise<{ praeforma: string; anatomia: string; anatomiaProjectId: string; anatomiaBaseUrl: string }>((resolve) => { release = resolve; });
    const deps = { sessions: { findSession: () => current }, projectCodes: { list: () => [{ code: "R", ddd_enabled: 1 }] },
      resolveLinks: () => links,
      repositoryIdentity: async (path: string) => path === "E:/other-repo" ? "E:/other-repo" : "E:/repo-main" };
    const pending = allowDelegationDomainPreamble(deps as never, "s", "E:/repo-other-worktree");
    current = { ...session, branch: "feat/changed" };
    release({ praeforma: "", anatomia: "http://an/api/projects/r/domains", anatomiaProjectId: "r", anatomiaBaseUrl: "http://an" });
    expect(await pending).toBeNull();
    current = session;
    const verified = await allowDelegationDomainPreamble({ ...deps, resolveLinks: async () => ({ praeforma: "", anatomia: "http://an", anatomiaProjectId: "r", anatomiaBaseUrl: "http://an" }) } as never,
      "s", "E:/repo-other-worktree");
    expect(verified).toEqual(expect.objectContaining({ projectId: "r", baseUrl: "http://an" }));
    expect(verified?.isCurrent()).toBe(true);
    current = { ...session, branch: "feat/changed" };
    expect(verified?.isCurrent()).toBe(false);
    current = session;
    expect(await allowDelegationDomainPreamble(deps as never, "s", "E:/other-repo")).toBeNull();
  });
});
