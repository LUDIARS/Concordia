/** @implements spec/feature/task-workflow-v3.md — Actio task sync: handoff reuse and run takeover (CC-TF-SYNC-02, CC-TF-SYNC-03) */

import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "./delegation-repo.js";
import { isDelegationRunOver, listTaskRunsOnBranch } from "./delegation-task-runs.js";

let db: Database.Database;
let repo: DelegationRepo;

function session(id: string, status: string): void {
  db.prepare(`INSERT INTO sessions(id, provider, repo_path, host, started_at, status, last_seen_at)
    VALUES (?, 'claude-code', 'E:/x', 'h', 1, ?, 1)`).run(id, status);
}

function run(id: string, overrides: { status?: "running" | "completed"; child?: string | null; args?: Record<string, unknown>; branch?: string; at?: number } = {}): void {
  repo.createRun({
    id, template_id: null, call_name: "impl", target_provider: "claude", child_session_id: overrides.child ?? null,
    args: overrides.args ?? { target_repo: "E:/Document/Ars/Concordia", taskflow_reference: `actio:${id}` },
    rendered_prompt: "", prompt_file_path: "/p", spawn_pid: null, spawn_command: null, triggered_by: null,
    status: overrides.status ?? "running", spawn_branch: overrides.branch ?? "feat/x", created_at: overrides.at ?? 1,
  });
}

beforeEach(() => {
  db = makeTestDb();
  repo = new DelegationRepo(db);
});

describe("listTaskRunsOnBranch", () => {
  it("reads the task reference, target repository and child session state of runs on a branch", () => {
    session("s1", "lost");
    run("a", { child: "s1", at: 1 });
    run("b", { branch: "feat/other", at: 2 });
    run("c", { args: { task: "no reference" }, at: 3 });
    expect(listTaskRunsOnBranch(db, "feat/x")).toEqual([
      { runId: "c", reference: null, targetRepo: null, branch: "feat/x", runStatus: "running", sessionStatus: null, createdAt: 3 },
      { runId: "a", reference: "actio:a", targetRepo: "E:/Document/Ars/Concordia", branch: "feat/x", runStatus: "running", sessionStatus: "lost", createdAt: 1 },
    ]);
  });
});

describe("isDelegationRunOver", () => {
  it("lets a new run take over only after the previous run stopped working", () => {
    session("alive", "active");
    session("gone", "ended");
    run("working", { child: "alive" });
    run("ended", { child: "gone" });
    run("done", { status: "completed" });
    expect(isDelegationRunOver(db, "working")).toBe(false);
    expect(isDelegationRunOver(db, "ended")).toBe(true);
    expect(isDelegationRunOver(db, "done")).toBe(true);
    // 封印直後で行がまだ無い run は作業中として扱い、排他を保つ。
    expect(isDelegationRunOver(db, "missing")).toBe(false);
  });
});
