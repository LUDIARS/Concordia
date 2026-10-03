import { beforeEach, describe, expect, it } from "vitest";
import type { DelegationRunRow, DelegationTemplateRow } from "../../db/delegation-repo.js";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { childRunFacts, guardSidecarInvoke, recordSidecarLaunch, type SidecarInvokeGuardPorts } from "./invoke-guard.js";
import { SidecarRecordsRepo } from "./records-repo.js";

const PARENT = "parent-session";
const packet = {
  task_reference: "actio:task-1",
  request_version: 1,
  authorization_ref: "discord:1",
  repo_path: "E:/Document/Ars/Concordia",
  origin: "https://github.com/LUDIARS/Concordia.git",
  base_commit: "108b43bd",
  editable_paths: ["src/a.ts"],
  child_branch: "sidecar/a",
  objective: "fix a",
  design_refs: ["spec/feature/a.md", "https://example.com/doc"],
  acceptance: ["a works"],
  verification: "none",
  completion_scope: "local PR",
};

let records: SidecarRecordsRepo;
let runs: DelegationRunRow[];
let parentMetadata: string;

function ports(): SidecarInvokeGuardPorts {
  return {
    findSession: (id) => id === PARENT ? { metadata: parentMetadata, branch: "feat/parent" } : null,
    findTemplateByCallName: (name) => name === "sol-mid" ? {
      call_name: "sol-mid", is_active: 1, target_provider: "codex", model: "gpt-6.1-sol",
      runtime_options_json: JSON.stringify({ model_reasoning_effort: "medium" }),
    } as DelegationTemplateRow : null,
    listRunsByParentSession: () => runs,
    records,
    now: () => 1_000,
  };
}

beforeEach(() => {
  records = new SidecarRecordsRepo(makeTestDb());
  runs = [];
  parentMetadata = JSON.stringify({ delegation_call_name: "astra-with-sidecar" });
});

describe("guardSidecarInvoke", () => {
  it("does nothing for ordinary parents", () => {
    parentMetadata = JSON.stringify({ delegation_call_name: "astra-mid" });
    expect(guardSidecarInvoke(ports(), { call_name: "opus-mid", args: {}, parent_session_id: PARENT }).kind).toBe("not_sidecar");
    expect(guardSidecarInvoke(ports(), { call_name: "opus-mid", args: {}, parent_session_id: null }).kind).toBe("not_sidecar");
  });

  it("builds a profile-pinned, worktree-isolated launch from the packet", () => {
    const result = guardSidecarInvoke(ports(), {
      call_name: "sol-mid",
      args: { sidecar_packet: packet },
      parent_session_id: PARENT,
      triggered_by: "parent-tool",
    });
    expect(result.kind).toBe("allow");
    if (result.kind !== "allow") return;
    expect(result.input).toMatchObject({
      call_name: "sol-mid",
      cwd: packet.repo_path,
      branch: "sidecar/a",
      worktree: true,
      base_ref: "108b43bd",
      parent_session_id: PARENT,
      overrides: { provider: "codex", model: "gpt-6.1-sol", reasoning_effort: "medium" },
      memory_links: ["spec/feature/a.md"],
    });
    expect(result.input.args.context_extra).toContain("## Sidecar 委任契約");
    expect(result.input.args).not.toHaveProperty("sidecar_packet");
    expect(result.requestKey).toBe("actio:task-1#v1");
  });

  it("rejects and records a missing packet", () => {
    const result = guardSidecarInvoke(ports(), { call_name: "sol-mid", args: {}, parent_session_id: PARENT });
    expect(result).toMatchObject({ kind: "reject", status: 400, code: "sidecar_packet_invalid" });
    expect(records.listInvokeEvents(PARENT)[0]).toMatchObject({ outcome: "rejected", code: "sidecar_packet_invalid" });
  });

  it("returns 409 while another sidecar run is unfinished", () => {
    runs = [{ id: "r1", status: "running" } as DelegationRunRow];
    const result = guardSidecarInvoke(ports(), { call_name: "sol-mid", args: { sidecar_packet: packet }, parent_session_id: PARENT });
    expect(result).toMatchObject({ kind: "reject", status: 409, code: "sidecar_concurrency_limit", blocking_run_ids: ["r1"] });
  });

  it("counts earlier attempts from the launch records", () => {
    for (const id of ["r1", "r2", "r3"]) {
      runs.push({ id, status: "failed" } as DelegationRunRow);
      recordSidecarLaunch(ports(), { parentSessionId: PARENT, requestKey: "actio:task-1#v1", runId: id, error: null });
    }
    const result = guardSidecarInvoke(ports(), { call_name: "sol-mid", args: { sidecar_packet: packet }, parent_session_id: PARENT });
    expect(result).toMatchObject({ kind: "reject", status: 409, code: "sidecar_attempt_limit" });
  });
});

describe("childRunFacts", () => {
  it("maps request keys onto runs and keeps launch failures as attempts", () => {
    recordSidecarLaunch(ports(), { parentSessionId: PARENT, requestKey: "k#v1", runId: "r1", error: null });
    recordSidecarLaunch(ports(), { parentSessionId: PARENT, requestKey: "k#v1", runId: null, error: "worktree failed" });
    const facts = childRunFacts([{ id: "r1", status: "completed" } as DelegationRunRow], records.listInvokeEvents(PARENT));
    expect(facts).toHaveLength(2);
    expect(facts[0]).toEqual({ id: "r1", status: "completed", request_key: "k#v1" });
    expect(facts[1]).toMatchObject({ status: "spawn_failed", request_key: "k#v1" });
  });
});
