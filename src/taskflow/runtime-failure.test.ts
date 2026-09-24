import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { CompletionBlackbox } from "./completion-blackbox.js";
import { TaskflowRuntime, type TaskflowRuntimeDeps } from "./runtime.js";
import type { RevisorLocalPr } from "../pr/revisor-client.js";

function fixture() {
  const row = { id: "runtime-failure-test", status: "active", metadata: "{}",
    repo_path: "repo", repo_origin: "https://github.com/owner/repo.git", branch: "feat/task" };
  const sessions = {
    findSession: vi.fn(() => row), findReport: vi.fn(() => null),
    recentEvents: vi.fn(() => [{ kind: "final_answer", payload: JSON.stringify({ text: "実装完了" }) }]),
    mergeMetadata: vi.fn((_id: string, patch: Record<string, unknown>) => {
      row.metadata = JSON.stringify({ ...JSON.parse(row.metadata), ...patch });
    }), appendEvent: vi.fn(),
  };
  const revisor = { listLocalPrs: vi.fn(async (): Promise<RevisorLocalPr[]> => [{
    id: "local-1", number: 7, repository: "owner/repo", title: "Fix taskflow", author: "cc",
    status: "open", checkStatus: "pending", headRef: "feat/task", baseRef: "main", headSha: "abc",
    createdAt: "", updatedAt: "",
  }]), baseUrl: async () => "http://unused" };
  const store = { findForProject: vi.fn(async (_repo: string, statuses: string[]): Promise<unknown[]> =>
    statuses.includes("delegated") ? [{}] : []) };
  const runtime = new TaskflowRuntime({
    db: makeTestDb(), sessions, delegation: { findRunByChildSession: () => null },
    prs: { list: () => [] }, store, revisor, confirm: {}, mentionUserId: () => null,
  } as unknown as TaskflowRuntimeDeps);
  const events: ConcordiaEvent[] = [];
  const stopEvents = eventBus.subscribe((event) => events.push(event));
  const handle = runtime.start();
  const decide = vi.spyOn(CompletionBlackbox.prototype, "decide")
    .mockResolvedValue({ verdict: "completed", decisionId: 1 });
  return { row, sessions, revisor, store, events, decide,
    fire: () => eventBus.emit({ type: "session.event", session_id: row.id, kind: "final_answer", ts: 1 }),
    close: () => { handle.stop(); stopEvents(); decide.mockRestore(); },
  };
}

describe("interactive completion failure boundary", () => {
  it("passes the Revisor reader into goal evaluation and recognizes an existing local PR", async () => {
    const f = fixture();
    try {
      f.fire();
      await vi.waitFor(() => expect(f.events.some((event) => event.type === "taskflow.residual_checked")).toBe(true));
      expect(f.revisor.listLocalPrs).toHaveBeenCalledTimes(2);
      expect(f.events.filter((event) => event.type === "taskflow.user_decision")).toEqual([]);
    } finally { f.close(); }
  });

  it("reports a Revisor outage once, without completion or residual work", async () => {
    const f = fixture();
    try {
      f.revisor.listLocalPrs.mockRejectedValue(new Error("secret-token response"));
      f.fire();
      await vi.waitFor(() => expect(f.events.some((event) => event.type === "taskflow.user_decision")).toBe(true));
      expect(f.decide).not.toHaveBeenCalled();
      expect(f.store.findForProject).not.toHaveBeenCalled();
      const notices = f.events.filter((event) => event.type === "taskflow.user_decision");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ kind: "question", text: expect.stringContaining("revisor_lookup_unavailable") });
      expect(JSON.stringify(notices)).not.toContain("secret-token");
      f.fire();
      await Promise.resolve();
      expect(f.revisor.listLocalPrs).toHaveBeenCalledOnce();
      expect(JSON.parse(f.row.metadata).human_response_confirmation).toBe(true);
    } finally { f.close(); }
  });

  it("does not mislabel an internal failure as an Actio outage", async () => {
    const f = fixture();
    try {
      f.decide.mockRejectedValue(new Error("database secret-token"));
      f.fire();
      await vi.waitFor(() => expect(f.events.some((event) => event.type === "taskflow.user_decision")).toBe(true));
      const notice = f.events.find((event) => event.type === "taskflow.user_decision");
      expect(notice).toMatchObject({ text: expect.stringContaining("taskflow_internal_error") });
      expect(JSON.stringify(notice)).not.toContain("secret-token");
      expect(f.store.findForProject).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it("preserves an existing human-response wait", async () => {
    const f = fixture();
    try {
      f.row.metadata = JSON.stringify({ human_response_confirmation: true });
      f.fire();
      await Promise.resolve();
      expect(f.revisor.listLocalPrs).not.toHaveBeenCalled();
      expect(f.sessions.mergeMetadata).not.toHaveBeenCalled();
      expect(f.events.filter((event) => event.type === "taskflow.user_decision")).toEqual([]);
    } finally { f.close(); }
  });
});
