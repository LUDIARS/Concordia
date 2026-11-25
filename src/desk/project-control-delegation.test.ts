import { expect, it, vi } from "vitest";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { DeskRequest } from "./desk-request-policy.js";
import { createDeskDelegationPorts, type DeskDelegationDeps } from "./project-control-delegation.js";
import { projectControlStartup } from "./project-control-prompt.js";

const project = { code: "Cc", repoPath: "/repos/Concordia", name: "Concordia" };
const request = { id: "request", task_reference: "actio:task", session_id: "control" } as DeskRequest;

it("既存の Actio 参照を Sol と専任管制に結び付け、再委託は前のブランチを再利用する", async () => {
  const prior = { id: "first", triggered_by: "desk-request:request:initial", spawn_branch: "feat/task",
    status: "failed", child_session_id: "child" } as DelegationRunRow;
  const invoke = vi.fn<DeskDelegationDeps["invoke"]>(async () => ({ ok: false, error: "fake result" }));
  const childStopped = vi.fn(() => false);
  const ports = createDeskDelegationPorts({
    findRun: (trigger) => trigger === prior.triggered_by ? prior : null,
    findRunByChild: (id) => id === "child" ? prior : null,
    invoke, childStopped,
  });
  expect(ports.requestForChildSession("child")).toBe("request");
  expect(ports.delegationRun(request.id)?.state).toBe("failed");
  childStopped.mockReturnValue(true);
  expect(ports.delegationRun(request.id)?.state).toBe("retryable");
  await ports.delegate(request, project, true);
  expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
    call_name: "sol", parent_session_id: "control", cwd: project.repoPath, worktree: true, branch: "feat/task",
    triggered_by: "desk-request:request:retry", args: expect.objectContaining({ taskflow_reference: "actio:task" }),
  }));
});

it("起動案内は専任管制に受け箱の受付、同時上限、監督を伝える", () => {
  expect(projectControlStartup("Cc")).toContain("Cc 専任のプロジェクト管制");
  expect(projectControlStartup("Cc")).toContain("同時に 2 件");
  expect(projectControlStartup("Cc")).toContain("子の進捗と結果を監督");
});
