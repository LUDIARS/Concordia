import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { addSessionTaskLink, readLinkedTaskViews, readSessionTaskLinks } from "./session-task-links.js";

function fixture() {
  const sessions = new SessionsRepo(makeTestDb());
  sessions.insertSession({ id: "s", provider: "codex-cli", repo_path: "/repo", repo_origin: null,
    branch: "feature", host: "test", started_at: 1, last_seen_at: 1, transcript_path: null,
    metadata: JSON.stringify({ subsidiary_id: "team-a", unrelated: "keep" }) });
  return sessions;
}

describe("session instruction to Actio task links", () => {
  it("stores only explicit references and treats a repeated link as the same operation", async () => {
    const sessions = fixture();
    const read = vi.fn(async () => ({ path: "actio:T-1", repoPath: "/repo", frontmatter: { actio_status: "open" } }));
    const input = { sessions, tasks: { read } as never, sessionId: "s", instructionRef: "human-message-1", taskReference: "actio:T-1", now: () => 100 };
    expect((await addSessionTaskLink(input)).kind).toBe("linked");
    expect((await addSessionTaskLink(input)).kind).toBe("existing");
    expect(read).toHaveBeenCalledWith("/repo", "actio:T-1", "team-a");
    expect(readSessionTaskLinks(sessions.findSession("s")!.metadata)).toEqual([
      { instruction_ref: "human-message-1", task_reference: "actio:T-1", linked_at: 100,
        repo_path: "/repo", repo_origin: null, target_project: null, subsidiary_id: "team-a" },
    ]);
    expect(JSON.parse(sessions.findSession("s")!.metadata!).unrelated).toBe("keep");
  });

  it("prefers the reference-only read so legacy tasks can be linked and shown (CC-TASK-LINKED-FOLLOWUP)", async () => {
    const sessions = fixture();
    const read = vi.fn(async () => { throw new Error("Actio task ownership mismatch"); });
    const readReference = vi.fn(async () => ({ path: "actio:L-1", repoPath: "/repo", frontmatter: { actio_status: "done", legacy_source: "cc-taskmd" } }));
    const tasks = { read, readReference } as never;
    const input = { sessions, tasks, sessionId: "s", instructionRef: "human-message-legacy", taskReference: "actio:L-1", now: () => 100 };
    expect((await addSessionTaskLink(input)).kind).toBe("linked");
    expect(readReference).toHaveBeenCalledWith("/repo", "actio:L-1", "team-a");
    expect(read).not.toHaveBeenCalled();
    const views = await readLinkedTaskViews({ sessions, tasks, sessionId: "s" });
    expect(views.links.map((link) => [link.task_reference, link.status, link.state])).toEqual([["actio:L-1", "done", "current"]]);
  });

  it("still reports an out-of-scope reference from the reference-only read", async () => {
    const sessions = fixture();
    const readReference = vi.fn(async () => { throw new Error("Actio task ownership mismatch"); });
    const result = await addSessionTaskLink({ sessions, tasks: { readReference } as never, sessionId: "s",
      instructionRef: "human-message-other", taskReference: "actio:X-1" });
    expect(result.kind).toBe("task_out_of_scope");
    expect(readSessionTaskLinks(sessions.findSession("s")!.metadata)).toEqual([]);
  });

  it("does not save a result from a previous branch after the Actio read", async () => {
    const sessions = fixture();
    let complete!: (value: { path: string; repoPath: string }) => void;
    const read = vi.fn(() => new Promise<{ path: string; repoPath: string }>((resolve) => { complete = resolve; }));
    const pending = addSessionTaskLink({ sessions, tasks: { read } as never, sessionId: "s",
      instructionRef: "human-message-2", taskReference: "actio:T-2" });
    sessions.patchSession("s", { branch: "other" });
    complete({ path: "actio:T-2", repoPath: "/repo" });
    expect((await pending).kind).toBe("stale_binding");
    expect(readSessionTaskLinks(sessions.findSession("s")!.metadata)).toEqual([]);
  });

  it("reports Actio outage as unknown while keeping the saved reference", async () => {
    const sessions = fixture();
    sessions.mergeMetadata("s", { cc_task_links: [{ instruction_ref: "human-message-1", task_reference: "actio:T-1", linked_at: 100,
      repo_path: "/repo", repo_origin: null, target_project: null, subsidiary_id: "team-a" }] });
    const result = await readLinkedTaskViews({ sessions, tasks: { read: async () => { throw new Error("offline"); } } as never, sessionId: "s" });
    expect(result).toMatchObject({ kind: "current", links: [{ task_reference: "actio:T-1", status: "unknown", state: "unknown" }] });
  });

  it("keeps a link across branch changes but does not reuse it for another repository", async () => {
    const sessions = fixture();
    const tasks = { read: async () => ({ path: "actio:T-1", repoPath: "/repo", frontmatter: { actio_status: "blocked" } }) };
    const input = { sessions, tasks: tasks as never, sessionId: "s", instructionRef: "human-message-1", taskReference: "actio:T-1" };
    expect((await addSessionTaskLink(input)).kind).toBe("linked");
    sessions.patchSession("s", { branch: "other" });
    expect((await readLinkedTaskViews({ sessions, tasks: tasks as never, sessionId: "s" })).links).toMatchObject([{ status: "blocked" }]);
    sessions.patchSession("s", { repo_path: "/another" });
    expect((await readLinkedTaskViews({ sessions, tasks: tasks as never, sessionId: "s" })).links).toEqual([]);
    const otherRepoTasks = { read: async () => ({ path: "actio:T-1", repoPath: "/another", frontmatter: { actio_status: "open" } }) };
    expect((await addSessionTaskLink({ ...input, tasks: otherRepoTasks as never })).kind).toBe("linked");
    expect(readSessionTaskLinks(sessions.findSession("s")!.metadata)).toHaveLength(2);
  });

  it("separates out-of-scope references, missing tasks and Actio outages", async () => {
    const sessions = fixture();
    const input = { sessions, sessionId: "s", instructionRef: "human-message-1", taskReference: "actio:T-1" };
    const result = async (message: string) => addSessionTaskLink({ ...input,
      tasks: { read: async () => { throw new Error(message); } } as never });
    expect((await result("Actio task ownership mismatch")).kind).toBe("task_out_of_scope");
    expect((await result("Actio task project binding missing or ambiguous")).kind).toBe("task_out_of_scope");
    expect((await result("Actio task request rejected (404)")).kind).toBe("not_found");
    expect((await result("Actio task service unavailable")).kind).toBe("task_unavailable");
    expect(readSessionTaskLinks(sessions.findSession("s")!.metadata)).toEqual([]);
  });
});
