import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { addSessionTaskLink, readLinkedTaskViews, readSessionTaskLinks, sessionTaskRepoCandidates } from "./session-task-links.js";
import { readTaskLinkFailures } from "./task-link-failures.js";

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

  it("links a task of the checkout's project when the declared target is another project (162bc3a6)", async () => {
    const sessions = fixture();
    // target_project inferred from a branch like fix/actio-… while the checkout is Concordia.
    sessions.patchSession("s", { target_project: "/actio" });
    const readReference = vi.fn(async (repoPath: string, reference: string) => {
      if (repoPath === "/actio") throw new Error("Actio task ownership mismatch");
      return { path: reference, repoPath: "/repo", frontmatter: { actio_status: "open", legacy_source: "cc-command" } };
    });
    const tasks = { readReference } as never;
    const result = await addSessionTaskLink({ sessions, tasks, sessionId: "s", instructionRef: "msg", taskReference: "actio:C-1" });
    expect(result).toMatchObject({ kind: "linked", link: { repo_path: "/repo", target_project: "/actio" } });
    expect(readReference.mock.calls.map((call) => call[0])).toEqual(["/actio", "/repo"]);
    const views = await readLinkedTaskViews({ sessions, tasks, sessionId: "s" });
    expect(views.links.map((link) => [link.status, link.state])).toEqual([["open", "current"]]);
  });

  it("keeps a task outside every session project out of scope and records the reason once", async () => {
    const sessions = fixture();
    sessions.patchSession("s", { target_project: "/actio" });
    const readReference = vi.fn(async () => { throw new Error("Actio task ownership mismatch"); });
    const input = { sessions, tasks: { readReference } as never, sessionId: "s", instructionRef: "msg", taskReference: "actio:X-9", now: () => 7 };
    expect((await addSessionTaskLink(input)).kind).toBe("task_out_of_scope");
    expect((await addSessionTaskLink(input)).kind).toBe("task_out_of_scope");
    expect(readReference).toHaveBeenCalledTimes(4);
    expect(readTaskLinkFailures(sessions.findSession("s")!.metadata)).toEqual([
      { task_reference: "actio:X-9", reason: "task_out_of_scope", at: 7 },
    ]);
    expect(readSessionTaskLinks(sessions.findSession("s")!.metadata)).toEqual([]);
  });

  it("does not try another project after a 404 or an outage, and does not record an outage", async () => {
    const sessions = fixture();
    sessions.patchSession("s", { target_project: "/actio" });
    const run = async (message: string) => {
      const readReference = vi.fn(async () => { throw new Error(message); });
      const kind = (await addSessionTaskLink({ sessions, tasks: { readReference } as never, sessionId: "s",
        instructionRef: "msg", taskReference: "actio:N-1" })).kind;
      return [kind, readReference.mock.calls.length];
    };
    expect(await run("Actio task service unavailable")).toEqual(["task_unavailable", 1]);
    expect(readTaskLinkFailures(sessions.findSession("s")!.metadata)).toEqual([]);
    expect(await run("Actio task request rejected (404)")).toEqual(["not_found", 1]);
    expect(readTaskLinkFailures(sessions.findSession("s")!.metadata)).toMatchObject([{ task_reference: "actio:N-1", reason: "not_found" }]);
  });

  it("clears the recorded failure once the same task is linked", async () => {
    const sessions = fixture();
    let inScope = false;
    const readReference = vi.fn(async (_repoPath: string, reference: string) => {
      if (!inScope) throw new Error("Actio task ownership mismatch");
      return { path: reference, repoPath: "/repo", frontmatter: { actio_status: "open" } };
    });
    const input = { sessions, tasks: { readReference } as never, sessionId: "s", instructionRef: "msg", taskReference: "actio:R-1" };
    expect((await addSessionTaskLink(input)).kind).toBe("task_out_of_scope");
    expect(readTaskLinkFailures(sessions.findSession("s")!.metadata)).toHaveLength(1);
    inScope = true;
    expect((await addSessionTaskLink(input)).kind).toBe("linked");
    expect(readTaskLinkFailures(sessions.findSession("s")!.metadata)).toEqual([]);
    expect(JSON.parse(sessions.findSession("s")!.metadata!)).not.toHaveProperty("cc_task_link_failures");
  });

  it("tries the declared target and then the checkout, once each", () => {
    expect(sessionTaskRepoCandidates({ repo_path: "E:\\Ars\\Concordia", target_project: "E:/Ars/Actio" })).toEqual(["E:/Ars/Actio", "E:\\Ars\\Concordia"]);
    expect(sessionTaskRepoCandidates({ repo_path: "E:\\Ars\\Concordia", target_project: "e:/ars/concordia/" })).toEqual(["e:/ars/concordia/"]);
    expect(sessionTaskRepoCandidates({ repo_path: "/repo", target_project: "/Repo" })).toEqual(["/Repo", "/repo"]);
    expect(sessionTaskRepoCandidates({ repo_path: "/repo", target_project: null })).toEqual(["/repo"]);
  });

  it("reports why a linked task state is unknown instead of swallowing it", async () => {
    const sessions = fixture();
    let readReference = vi.fn(async () => ({ path: "actio:T-2", repoPath: "/repo", frontmatter: { actio_status: "open" } }));
    const tasks = { readReference: (...args: unknown[]) => readReference(...(args as [])) } as never;
    expect((await addSessionTaskLink({ sessions, tasks, sessionId: "s", instructionRef: "msg", taskReference: "actio:T-2" })).kind).toBe("linked");
    const reasonOf = async () => (await readLinkedTaskViews({ sessions, tasks, sessionId: "s" })).links.map((link) => [link.status, link.reason]);

    readReference = vi.fn(async () => { throw new Error("Actio task ownership mismatch"); });
    expect(await reasonOf()).toEqual([["unknown", "task_out_of_scope"]]);
    readReference = vi.fn(async () => { throw new Error("Actio task request rejected (404)"); });
    expect(await reasonOf()).toEqual([["unknown", "not_found"]]);
    readReference = vi.fn(async () => { throw new Error("fetch failed"); });
    expect(await reasonOf()).toEqual([["unknown", "task_unavailable"]]);
    readReference = vi.fn(async () => ({ path: "actio:T-2", repoPath: "/repo", frontmatter: { actio_status: "review" } }));
    expect(await reasonOf()).toEqual([["unknown", "status_unrecognized"]]);
    readReference = vi.fn(async () => ({ path: "actio:T-2", repoPath: "/other", frontmatter: { actio_status: "open" } }));
    expect(await reasonOf()).toEqual([["unknown", "task_out_of_scope"]]);
    readReference = vi.fn(async () => ({ path: "actio:T-2", repoPath: "/repo", frontmatter: { actio_status: "in_progress" } }));
    expect(await reasonOf()).toEqual([["in_progress", undefined]]);
  });
});
