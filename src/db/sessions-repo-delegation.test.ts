import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "./sessions-repo.js";

describe("SessionsRepo.listDelegationSessionsForRun", () => {
  it("returns only the exact and bounded legacy candidates", () => {
    const repo = new SessionsRepo(makeTestDb());
    insert(repo, "child", 1_200, null);
    insert(repo, "by-run", 1_100, { delegation_run_id: "run-1" });
    insert(repo, "by-trimmed-run", 1_101, { delegation_run_id: " run-1 " });
    insert(repo, "legacy", 1_500, { delegation_call_name: "impl" });
    insert(repo, "legacy-trimmed", 1_499, { delegation_call_name: " impl " });
    insert(repo, "legacy-blank-run", 1_498, { delegation_run_id: " ", delegation_call_name: "impl" });
    insert(repo, "legacy-non-string-run", 1_497, { delegation_run_id: [], delegation_call_name: "impl" });
    insert(repo, "wrong-run", 1_500, { delegation_run_id: "run-2", delegation_call_name: "impl" });
    insert(repo, "wrong-call", 1_500, { delegation_call_name: "review" });
    insert(repo, "too-early", 900, { delegation_call_name: "impl" });
    insert(repo, "too-late", 2_101, { delegation_call_name: "impl" });
    insert(repo, "malformed", 1_500, "not-json");
    insert(repo, "non-object", 1_500, "null");

    const rows = repo.listDelegationSessionsForRun({
      runId: "run-1",
      childSessionId: "child",
      callName: "impl",
      createdAtMs: 1_500_999,
    });

    expect(rows.map((row) => row.id)).toEqual([
      "legacy",
      "legacy-trimmed",
      "legacy-blank-run",
      "legacy-non-string-run",
      "child",
      "by-trimmed-run",
      "by-run",
    ]);
  });
});

function insert(repo: SessionsRepo, id: string, startedAt: number, metadata: object | string | null): void {
  repo.insertSession({
    id,
    provider: "codex-cli",
    repo_path: "C:/repo/worktree",
    repo_origin: null,
    branch: "feat/test",
    host: "test",
    started_at: startedAt,
    last_seen_at: startedAt,
    transcript_path: null,
    metadata: typeof metadata === "string" ? metadata : metadata ? JSON.stringify(metadata) : null,
  });
}
