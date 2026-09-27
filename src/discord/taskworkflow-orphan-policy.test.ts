import { describe, expect, it } from "vitest";
import { readTaskWorkflowStarter, shouldArchiveTaskWorkflowOrphan, TASKWORKFLOW_ORPHAN_GRACE_MS } from "./taskworkflow-orphan-policy.js";

const input = {
  trustedStarter: true,
  identity: { sessionId: "child", runId: "run" },
  runChildSessionId: "child",
  sessionStatus: null,
  hasChannelBinding: false,
  hasSessionBinding: false,
  createdAtMs: 1,
  nowMs: TASKWORKFLOW_ORPHAN_GRACE_MS + 1,
};

describe("TaskWorkflow orphan policy", () => {
  it("recognizes only the TaskWorkflow starter with run and repo metadata", () => {
    const content = '**TaskWorkflow** `child`\r\n**Delegation run** `run`\r\n**Repo** `Concordia`';
    expect(readTaskWorkflowStarter(content)).toEqual(input.identity);
    expect(readTaskWorkflowStarter(content.replace('TaskWorkflow', 'Session'))).toBeNull();
    expect(readTaskWorkflowStarter(content.replace('**Repo**', 'text'))).toBeNull();
    expect(readTaskWorkflowStarter(content.replace('**Delegation run**', 'text'))).toBeNull();
  });

  it.each([null, "ended", "lost"])("archives an old unbound thread with child status %s", (sessionStatus) => {
    expect(shouldArchiveTaskWorkflowOrphan({ ...input, sessionStatus })).toBe(true);
  });

  it.each([
    { trustedStarter: false }, { identity: null }, { runChildSessionId: null },
    { runChildSessionId: "different" }, { sessionStatus: "active" }, { sessionStatus: "unknown" },
    { hasChannelBinding: true }, { hasSessionBinding: true }, { createdAtMs: null },
    { createdAtMs: Number.NaN }, { createdAtMs: input.nowMs }, { createdAtMs: input.nowMs + 1000 },
  ])("keeps uncertain, active or newly created surfaces: %j", (patch) => {
    expect(shouldArchiveTaskWorkflowOrphan({ ...input, ...patch })).toBe(false);
  });
});
