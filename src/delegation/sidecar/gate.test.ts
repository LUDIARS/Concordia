import { describe, expect, it } from "vitest";
import { decideSidecarInvoke, type SidecarGateInput } from "./gate.js";
import type { SidecarPacket } from "./packet.js";

const packet: SidecarPacket = {
  task_reference: "actio:task-1",
  request_version: 2,
  authorization_ref: "discord:1",
  repo_path: "E:/Document/Ars/Concordia",
  origin: "https://github.com/LUDIARS/Concordia.git",
  base_commit: "108b43bd",
  editable_paths: ["src/a.ts"],
  child_branch: "sidecar/a",
  objective: "fix a",
  design_refs: [],
  acceptance: ["a works"],
  forbidden: [],
  open_questions: [],
  verification: "none",
  completion_scope: "local PR",
};

const solMid = {
  call_name: "sol-mid",
  is_active: 1,
  target_provider: "codex",
  model: "gpt-6-sol",
  runtime_options_json: JSON.stringify({ model_reasoning_effort: "medium" }),
};

function input(overrides: Partial<SidecarGateInput> = {}): SidecarGateInput {
  return {
    requestedCallName: "sol-mid",
    childTemplate: solMid,
    packet,
    childRuns: [],
    parentBranch: "feat/parent",
    requestedOverride: null,
    ...overrides,
  };
}

describe("decideSidecarInvoke", () => {
  it("allows the first attempt of a bounded request", () => {
    expect(decideSidecarInvoke(input())).toEqual({ allow: true, requestKey: "actio:task-1#v2", attempt: 1 });
  });

  it("delegates only to the profile child template", () => {
    const decision = decideSidecarInvoke(input({ requestedCallName: "opus-mid" }));
    expect(decision).toMatchObject({ allow: false, code: "sidecar_child_template_mismatch" });
  });

  it("stops with an explicit reason when the child template drifted", () => {
    const decision = decideSidecarInvoke(input({ childTemplate: { ...solMid, model: "gpt-5.6-sol" } }));
    expect(decision).toMatchObject({ allow: false, code: "sidecar_model_mismatch" });
  });

  it("rejects model / effort overrides instead of silently switching", () => {
    expect(decideSidecarInvoke(input({ requestedOverride: { model: "gpt-6-astra" } })))
      .toMatchObject({ allow: false, code: "sidecar_override_rejected" });
    expect(decideSidecarInvoke(input({ requestedOverride: { reasoning_effort: "xhigh" } })))
      .toMatchObject({ allow: false, code: "sidecar_override_rejected" });
    expect(decideSidecarInvoke(input({ requestedOverride: { model: "gpt-6-sol", reasoning_effort: "medium" } })).allow).toBe(true);
  });

  it("keeps the child on a different branch from the parent", () => {
    expect(decideSidecarInvoke(input({ parentBranch: "sidecar/a" })))
      .toMatchObject({ allow: false, code: "sidecar_branch_conflict" });
  });

  it.each(["queued", "launching", "pending", "spawned", "running", "blocked"])(
    "counts an unfinished %s run against the single concurrency slot",
    (status) => {
      const decision = decideSidecarInvoke(input({ childRuns: [{ id: "run-1", status, request_key: null }] }));
      expect(decision).toMatchObject({ allow: false, code: "sidecar_concurrency_limit", blockingRunIds: ["run-1"] });
    },
  );

  it("caps re-delegation of the same request version, including launch failures", () => {
    const runs = [
      { id: "r1", status: "failed", request_key: "actio:task-1#v2" },
      { id: "r2", status: "completed", request_key: "actio:task-1#v2" },
      { id: "launch-failed:3", status: "spawn_failed", request_key: "actio:task-1#v2" },
    ];
    expect(decideSidecarInvoke(input({ childRuns: runs }))).toMatchObject({ allow: false, code: "sidecar_attempt_limit" });
    expect(decideSidecarInvoke(input({ childRuns: runs, packet: { ...packet, request_version: 3 } })))
      .toEqual({ allow: true, requestKey: "actio:task-1#v3", attempt: 1 });
  });
});
