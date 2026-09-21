/** @implements spec/feature/task-workflow-v3.md — Agent contract / Explicit migration */

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { TaskflowStateStore } from "../taskflow/state-store.js";
import type { TaskCreateInput, TaskStore } from "../taskflow/store.js";
import type { TaskDocument } from "../taskflow/types.js";
import { registerActioTaskRoutes } from "./taskflow-actio.js";

const REPO = "E:/Document/Ars/Concordia";

function document(): TaskDocument {
  return {
    path: "actio:task-1", repoPath: REPO, title: "タイトル", body: "本文",
    frontmatter: { task: "task-1", project: "Concordia", kind: "実装", created: "2026-09-21", memory_links: ["mem-1"] },
    runtime: {
      status: "pending", subsidiary_id: null, source_session: null, assignee: null, owner: null,
      delegation_run_id: null, pr_number: null, memoria_task_id: null, actio_task_id: "task-1",
      memoria_registration_state: "idle",
    },
  };
}

function fixture(override: Partial<TaskStore> = {}) {
  const db = makeTestDb();
  const sessions = new SessionsRepo(db);
  sessions.insertSession({
    id: "s1", provider: "claude-code", repo_path: REPO, repo_origin: null, branch: "main", host: "h",
    started_at: 1, last_seen_at: 1, transcript_path: null, metadata: JSON.stringify({ subsidiary_id: "sub-1" }),
  });
  const state = new TaskflowStateStore(db);
  // The real store registers the execution reference while building the document.
  const register = (): TaskDocument => {
    state.registerActioReference(REPO, "actio:task-1", "task-1", null);
    return document();
  };
  const create = vi.fn(async (_input: TaskCreateInput) => register());
  const read = vi.fn(async (_repoPath: string, _reference: string, _subsidiaryId: string | null) => register());
  const app = new Hono();
  registerActioTaskRoutes(app, { store: { create, read, ...override } as unknown as TaskStore, sessions, state });
  return { app, create, read, state };
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const CREATE = {
  session_id: "s1", request_id: "6f1d3a2e-0b3c-4f2d-9d5e-8a7c1b2e3f40",
  title: "タイトル", body: "本文", kind: "実装", memory_links: ["mem-1"],
};

describe("POST /tasks", () => {
  it("registers the task under the session's repository and organization", async () => {
    const { app, create, state } = fixture();

    const response = await post(app, "/tasks", CREATE);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ reference: "actio:task-1", repo_path: REPO, status: "pending" });
    expect(create.mock.calls[0]![0]).toMatchObject({
      repoPath: REPO, subsidiaryId: "sub-1", title: "タイトル", body: "本文", kind: "実装", memoryLinks: ["mem-1"],
    });
    expect(state.find({ repoPath: REPO, taskPath: "actio:task-1" })?.source_session).toBe("s1");
  });

  /** The same request ID must reach Actio unchanged so a retry deduplicates there. */
  it("derives the source identity from the session and the caller's request id", async () => {
    const { app, create } = fixture();

    await post(app, "/tasks", CREATE);
    await post(app, "/tasks", CREATE);

    expect(create.mock.calls.map((call) => call[0].sourceRef))
      .toEqual([`session:s1:${CREATE.request_id}`, `session:s1:${CREATE.request_id}`]);
  });

  it("rejects a body that is not the documented contract", async () => {
    const { app, create } = fixture();

    for (const body of [
      { ...CREATE, request_id: "not-a-uuid" },
      { ...CREATE, title: "  " },
      { ...CREATE, body: "" },
      { ...CREATE, due_at: "2026-09-22" },
      { ...CREATE, extra: 1 },
    ]) {
      const response = await post(app, "/tasks", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_task_input" });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("reports an unknown session instead of guessing a repository", async () => {
    const { app } = fixture();

    const response = await post(app, "/tasks", { ...CREATE, session_id: "missing" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "session_not_found" });
  });

  /** Without an Actio store there is no fallback body storage — the call fails. */
  it("fails explicitly when no Actio-backed store is configured", async () => {
    const { app } = fixture({ create: undefined });

    expect((await post(app, "/tasks", CREATE)).status).toBe(503);
  });
});

describe("POST /tasks/import", () => {
  it("carries the source identity and the migrated status", async () => {
    const { app, create } = fixture();

    const response = await post(app, "/tasks/import", {
      session_id: "s1", source: "memoria", source_id: "2816", status: "delegated",
      title: "タイトル", body: "本文",
    });

    expect(response.status).toBe(201);
    expect(create.mock.calls[0]![0]).toMatchObject({
      sourceRef: "import:memoria:2816", status: "delegated", kind: "実装",
    });
  });

  it("only accepts the declared migration sources and statuses", async () => {
    const { app } = fixture();
    const base = { session_id: "s1", source_id: "1", title: "t", body: "b" };

    expect((await post(app, "/tasks/import", { ...base, source: "github", status: "pending" })).status).toBe(400);
    expect((await post(app, "/tasks/import", { ...base, source: "markdown", status: "waiting_human" })).status).toBe(400);
  });
});

describe("GET /tasks/content", () => {
  it("resolves the requesting session's repository before reading the task", async () => {
    const { app, read } = fixture();

    const response = await app.request("/tasks/content?session_id=s1&reference=actio:task-1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reference: "actio:task-1", title: "タイトル", body: "本文", memory_links: ["mem-1"], status: "pending",
    });
    expect(read).toHaveBeenCalledWith(REPO, "actio:task-1", "sub-1");
  });

  it("requires both the session and the reference", async () => {
    const { app } = fixture();

    expect((await app.request("/tasks/content?session_id=s1")).status).toBe(400);
    expect((await app.request("/tasks/content?reference=actio:task-1")).status).toBe(400);
    expect((await app.request("/tasks/content?session_id=missing&reference=actio:task-1")).status).toBe(404);
  });
});
