import { describe, expect, it, vi } from "vitest";
import { syncSessionPrEvidence } from "./sync-pr-evidence.js";

function fixture(worker: string | null = "session", repository = "owner/repo") {
  const setPrEvidence = vi.fn(async () => undefined);
  const input = {
    sessionId: "session", now: () => new Date("2026-09-26T00:00:00Z"),
    sessions: { findSession: () => ({ repo_origin: "owner/repo", repo_path: "repo", branch: "feature", current_task: "Task (actio:task-1)", metadata: null }) },
    prs: { list: () => [{ number: 1, repo_origin: repository, head_branch: "feature", state: "open", review_state: "approved", head_sha: "head", url: "https://github.com/owner/repo/pull/1" }] },
    store: { findForProject: async () => [{ path: "actio:task-1", repoPath: "repo", frontmatter: { working_session_id: worker } }], setPrEvidence },
  } as unknown as Parameters<typeof syncSessionPrEvidence>[0];
  return { input, setPrEvidence };
}

describe("PR evidence synchronization", () => {
  it("records the associated Github PR without claiming deployed state", async () => {
    const { input, setPrEvidence } = fixture();
    await syncSessionPrEvidence(input);
    expect(setPrEvidence).toHaveBeenCalledWith("repo", "actio:task-1", expect.objectContaining({ provider: "github", id: "1", reflection: "unknown", reviewed_head_sha: null }), null);
  });
  it("does not associate an identically numbered PR from another repository", async () => {
    const { input, setPrEvidence } = fixture("session", "other/repo");
    await syncSessionPrEvidence(input);
    expect(setPrEvidence).not.toHaveBeenCalled();
  });
  it("does not write over another worker's task", async () => {
    const { input, setPrEvidence } = fixture("other-session");
    await syncSessionPrEvidence(input);
    expect(setPrEvidence).not.toHaveBeenCalled();
  });
  it("records Revisor identity and reviewed head separately", async () => {
    const { input, setPrEvidence } = fixture();
    input.revisor = { baseUrl: async () => "http://localhost", listLocalPrs: async () => [{ id: "rv-id", number: 9, repository: "owner/repo", headRef: "feature", headSha: "new", reviewedHeadSha: "old", checkStatus: "test_ok", status: "open" }] } as unknown as typeof input.revisor;
    await syncSessionPrEvidence(input);
    expect(setPrEvidence).toHaveBeenCalledWith("repo", "actio:task-1", expect.objectContaining({ provider: "revisor", id: "rv-id", head_sha: "new", reviewed_head_sha: "old" }), null);
  });
});
