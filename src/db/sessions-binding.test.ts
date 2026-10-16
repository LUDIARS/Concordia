import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "./sessions-repo.js";

function fixture() {
  const db = makeTestDb();
  const repo = new SessionsRepo(db);
  repo.insertSession({ id: "fixture", provider: "codex-cli", repo_path: "/workspace", repo_origin: null,
    branch: "main", host: "test", started_at: 1, last_seen_at: 1, transcript_path: null,
    metadata: JSON.stringify({ unrelated: "preserved" }) });
  const expected = repo.findSession("fixture")!;
  const input = { expected, patch: { current_task: "[AC] projection", branch: "feat/projection",
    repo_path: "/workspace/ac-worktree", repo_origin: "https://github.com/example/ac.git",
    target_project: "/workspace/ac", active_repos: ["/workspace/ac-worktree"] },
    metadata: { explicit: "new-binding" }, event: { ts: 2, payload: { project_code: "AC" } } };
  return { db, repo, input };
}
describe("atomic implementation binding", () => {
  it("saves binding, metadata and evidence together", () => {
    const { repo, input } = fixture();
    expect(repo.commitImplementationBinding(input)).toBe(true);
    expect(repo.findSession("fixture")).toMatchObject({ repo_path: input.patch.repo_path,
      current_task: input.patch.current_task, branch: input.patch.branch });
    expect(JSON.parse(repo.findSession("fixture")!.metadata!)).toEqual({ unrelated: "preserved", explicit: "new-binding" });
    expect(repo.recentEvents("fixture")).toHaveLength(1);
  });
  it("rolls back all fields when saving evidence fails", () => {
    const { db, repo, input } = fixture();
    db.exec("CREATE TRIGGER reject_bind_event BEFORE INSERT ON session_events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    expect(() => repo.commitImplementationBinding(input)).toThrow("fixture failure");
    expect(repo.findSession("fixture")).toEqual(input.expected);
    expect(repo.recentEvents("fixture")).toEqual([]);
  });
  it.each(["repo_path", "branch", "current_task"] as const)("does not overwrite newer %s", (field) => {
    const { repo, input } = fixture();
    repo.patchSession("fixture", { [field]: "newer" });
    const before = repo.findSession("fixture");
    expect(repo.commitImplementationBinding(input)).toBe(false);
    expect(repo.findSession("fixture")).toEqual(before);
    expect(repo.recentEvents("fixture")).toEqual([]);
  });
  it("does not revive an ended session", () => {
    const { db, repo, input } = fixture();
    db.prepare("UPDATE sessions SET status='ended' WHERE id=?").run("fixture");
    expect(repo.commitImplementationBinding(input)).toBe(false);
    expect(repo.findSession("fixture")!.status).toBe("ended");
  });
});
