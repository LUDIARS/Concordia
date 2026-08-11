import { describe, expect, it } from "vitest";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { PrRecordRow } from "../db/pr-records-repo.js";
import type { SessionRow } from "../shared/types.js";
import type { TaskDocument } from "./md-store.js";
import { buildTaskflowOverview } from "./overview.js";

describe("taskflow overview", () => {
  it("joins task, assignee, delegation, PR, and CI state", () => {
    const overview = buildTaskflowOverview({
      documents: [task({ status: "delegated", source_session: "session-1" })],
      relativePath: () => "spec/tasks/one.md",
      sessions: [session()],
      runs: [run()],
      prs: [pr()],
      now: 123,
    });
    expect(overview.tasks[0]).toMatchObject({
      // pr.persona_name (遺構カラム) は使わず、session metadata の role_label を採る
      assignee: "Implementer Cat",
      source_session: "session-1",
      session_status: "active",
      delegation_run_id: "run-1",
      delegation_status: "running",
      pr: { number: 42, state: "open" },
      ci_status: "failure",
    });
    expect(overview.counts).toMatchObject({ total: 1, delegated: 1, ci_failure: 1 });
  });

  it("prefers explicit runtime assignment and PR number", () => {
    const overview = buildTaskflowOverview({
      documents: [task({ assignee: "neco", pr_number: 42 })],
      relativePath: () => "spec/tasks/one.md",
      sessions: [],
      runs: [],
      prs: [pr()],
      now: 123,
    });
    expect(overview.tasks[0]).toMatchObject({ assignee: "neco", pr: { number: 42 }, ci_status: "failure" });
  });

  it("exposes the parent/child lineage and resolves a child match before a parent match", () => {
    // 同じ session が run-A の親・run-B の子として現れても、 child 一致を先に採る
    // (混在 find だと runs の並びで親子表示が不定になる)。
    const asParent: DelegationRunRow = { ...run(), id: "run-A", parent_session_id: "session-1", child_session_id: "child-9" };
    const asChild: DelegationRunRow = { ...run(), id: "run-B", parent_session_id: "parent-7", child_session_id: "session-1" };
    const overview = buildTaskflowOverview({
      documents: [task({ source_session: "session-1", status: "delegated" })],
      relativePath: () => "spec/tasks/one.md",
      sessions: [session()],
      runs: [asParent, asChild],
      prs: [],
      now: 123,
    });
    expect(overview.tasks[0]).toMatchObject({
      delegation_run_id: "run-B",
      parent_session_id: "parent-7",
      child_session_id: "session-1",
    });
  });
});

function task(overrides: Partial<NonNullable<TaskDocument["runtime"]>>): TaskDocument {
  return {
    path: "E:/repo/spec/tasks/one.md",
    repoPath: "E:/repo",
    title: "One task",
    body: "# One task",
    frontmatter: {
      task: "one",
      project: "repo",
      kind: "実装",
      created: "2026-07-14",
    },
    runtime: {
      status: "pending", source_session: null, assignee: null, owner: null,
      delegation_run_id: null, pr_number: null, memoria_task_id: null, actio_task_id: null,
      memoria_registration_state: "idle", ...overrides,
    },
  };
}

function session(): SessionRow {
  return {
    id: "session-1", provider: "codex-cli", repo_path: "E:/repo", repo_origin: "LUDIARS/repo",
    branch: "codex/task", host: "host", started_at: 1, ended_at: null, status: "active",
    last_seen_at: 2, current_task: "One task", transcript_path: null,
    metadata: JSON.stringify({ role_label: "Implementer Cat" }), ws_clients: 1, target_project: null,
  };
}

function run(): DelegationRunRow {
  return {
    id: "run-1", template_id: null, call_name: "implement", target_provider: "codex",
    parent_session_id: null, child_session_id: "session-1", args_json: "{}", rendered_prompt: "",
    prompt_file_path: "", spawn_pid: 1, spawn_command: null, triggered_by: null, status: "running",
    error: null, queue_payload_json: null, created_at: 1,
  };
}

function pr(): PrRecordRow {
  return {
    id: 1, repo_origin: "LUDIARS/repo", repo_path: "E:/repo", number: 42, title: "Task PR",
    url: "https://github.com/LUDIARS/repo/pull/42", head_branch: "codex/task", base_branch: "main",
    state: "open", ci_status: "failure", review_state: "changes_requested", author_session_id: "session-1",
    persona_id: "persona-1", persona_name: "Reviewer Cat", additions: 1, deletions: 0, changed_files: 1,
    note: null, created_at: 1, updated_at: 2, merged_at: null, closed_at: null,
  };
}
