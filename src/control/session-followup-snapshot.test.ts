import { describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { resolveSessionFollowupSnapshot, type FollowupSnapshotPorts } from "./session-followup-snapshot.js";

const session = { id: "s", repo_path: "E:/repo", repo_origin: "https://github.com/LUDIARS/Concordia.git", branch: "feat/x" } as SessionRow;
const registry = [{ repository: "LUDIARS/Concordia", workflow: "revisor" }] as never;

function ports(overrides: Partial<FollowupSnapshotPorts> = {}): FollowupSnapshotPorts {
  return {
    linkedTasks: async () => ({ kind: "current", links: [{ status: "in_progress" }] }),
    repositories: async () => registry,
    localPrs: async () => [
      { sessionId: "s", headRef: "feat/x", status: "open", checkStatus: "running" },
      { sessionId: "other", headRef: "feat/x", status: "open", checkStatus: "test_ok" },
    ],
    githubPrs: () => [],
    delegations: () => [{ status: "running" }],
    ...overrides,
  };
}

describe("followup snapshot sources", () => {
  it("collects every source when all are reachable", async () => {
    const snapshot = await resolveSessionFollowupSnapshot(ports(), session);
    expect(snapshot).toEqual({ workflow: "revisor", tasks: [{ status: "in_progress" }], delegations: [{ status: "running" }],
      prs: [{ sessionId: "s", headRef: "feat/x", status: "open", checkStatus: "running" }], unavailable: [] });
  });

  it("keeps the review state when Actio fails, and the task state when Revisor fails", async () => {
    const actioDown = await resolveSessionFollowupSnapshot(ports({ linkedTasks: async () => { throw new Error("timeout"); } }), session);
    expect(actioDown.unavailable).toEqual(["actio"]);
    expect(actioDown.tasks).toEqual([{ status: "unknown" }]);
    expect(actioDown.prs).toHaveLength(1);

    const prsDown = await resolveSessionFollowupSnapshot(ports({ localPrs: async () => { throw new Error("aborted"); } }), session);
    expect(prsDown).toMatchObject({ workflow: "revisor", tasks: [{ status: "in_progress" }], prs: [], unavailable: ["revisor-prs"] });

    const localPrs = vi.fn();
    const registryDown = await resolveSessionFollowupSnapshot(ports({ repositories: async () => { throw new Error("x"); }, localPrs }), session);
    expect(registryDown).toMatchObject({ workflow: "unknown", tasks: [{ status: "in_progress" }], unavailable: ["revisor-registry"] });
    expect(localPrs).not.toHaveBeenCalled();
  });

  it("passes the unknown reason through and treats a stale binding as unknown", async () => {
    const reasoned = await resolveSessionFollowupSnapshot(ports({
      linkedTasks: async () => ({ kind: "current", links: [{ status: "unknown", reason: "task_out_of_scope" }] }),
    }), session);
    expect(reasoned.tasks).toEqual([{ status: "unknown", reason: "task_out_of_scope" }]);
    const stale = await resolveSessionFollowupSnapshot(ports({ linkedTasks: async () => ({ kind: "stale_binding", links: [] }) }), session);
    expect(stale.tasks).toEqual([{ status: "unknown" }]);
    expect(stale.unavailable).toEqual([]);
  });
});
