import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { stopWrappedSession, type WrappedSessionStopDeps } from "./wrapped-session-stop.js";

function deps(): { deps: WrappedSessionStopDeps; repo: SessionsRepo; enqueue: ReturnType<typeof vi.fn> } {
  const repo = new SessionsRepo(makeTestDb());
  const enqueue = vi.fn();
  return {
    repo,
    enqueue,
    deps: {
      repo,
      controlJobs: { enqueueStopProcess: enqueue },
      endFlow: { repo } as unknown as WrappedSessionStopDeps["endFlow"],
    },
  };
}

describe("stopWrappedSession", () => {
  it("止められないセッションは理由を返し、 状態も停止ジョブも変えない", async () => {
    const { deps: d, repo, enqueue } = deps();
    expect(await stopWrappedSession(d, "missing", { stoppedBy: "budget", source: "budget-exhausted" }))
      .toEqual({ ok: false, status: 404, error: "not_found" });
    repo.insertSession({
      id: "s1", provider: "claude-code", repo_path: "E:/repo", repo_origin: null, branch: null, host: "h",
      started_at: 1, last_seen_at: 1, transcript_path: null, metadata: JSON.stringify({ wrapped_by: "lictor" }),
    });
    expect(await stopWrappedSession(d, "s1", { stoppedBy: "budget", source: "budget-exhausted" }))
      .toEqual({ ok: false, status: 400, error: "session.metadata.lictor_pid missing" });
    expect(repo.findSession("s1")?.status).toBe("active");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
