/** @implements spec/feature/task-workflow-v3.md — decomposition registers tasks in Actio */

import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import type { TaskStore } from "./store.js";
import type { TaskDocument } from "./types.js";
import { DECOMPOSE_PROMPT, injectDecompositionWhenMissing } from "./decompose-inject.js";

const REPO = "E:/Document/Ars/Concordia";
let seq = 0;

function fixture(options: { existing?: TaskDocument[] } = {}) {
  const sessions = new SessionsRepo(makeTestDb());
  sessions.insertSession({
    id: "parent-1", provider: "claude-code", repo_path: REPO, repo_origin: null, branch: "main",
    host: "h", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null,
  });
  const findForProject = vi.fn(async () => options.existing ?? []);
  return { sessions, findForProject, store: { findForProject } as unknown as TaskStore };
}

function run(overrides: Partial<DelegationRunRow> = {}): DelegationRunRow {
  return {
    id: `run-${++seq}`, args_json: JSON.stringify({ target_repo: REPO }),
    parent_session_id: "parent-1", child_session_id: null, subsidiary_id: null,
    ...overrides,
  } as DelegationRunRow;
}

describe("DECOMPOSE_PROMPT", () => {
  it("points at Actio registration and never at a task file path", () => {
    expect(DECOMPOSE_PROMPT).toContain("task-workflow v3.0");
    expect(DECOMPOSE_PROMPT).toContain("POST /v1/taskflow/tasks");
    expect(DECOMPOSE_PROMPT).not.toContain("spec/tasks/");
  });
});

describe("injectDecompositionWhenMissing", () => {
  it("injects once and records the run as its source", async () => {
    const { sessions, store } = fixture();
    const target = run();
    const emitted: unknown[] = [];
    const off = eventBus.subscribe((event) => emitted.push(event));

    try {
      expect(await injectDecompositionWhenMissing({ run: target, sessions, store })).toBe(true);
    } finally { off(); }

    const event = sessions.recentEvents("parent-1", 10).find((row) => row.kind === "inject");
    expect(JSON.parse(event!.payload)).toMatchObject({ text: DECOMPOSE_PROMPT, source: `taskflow:${target.id}:decompose` });
    expect(emitted).toContainEqual(expect.objectContaining({ type: "session.inject", target_session_id: "parent-1" }));
  });

  it("does not inject when the project already has open tasks in Actio", async () => {
    const { sessions, store, findForProject } = fixture({
      existing: [{ path: "actio:task-1", repoPath: REPO, title: "t", body: "", frontmatter: { task: "t", project: "Concordia", kind: "実装", created: "2026-09-21" } }],
    });

    expect(await injectDecompositionWhenMissing({ run: run(), sessions, store })).toBe(false);
    expect(findForProject).toHaveBeenCalledWith(REPO, ["pending", "delegated"], null);
  });

  /** The in-memory guard is lost on restart; the persisted event is the real ledger. */
  it("stays exactly-once across a restart by reading the persisted inject event", async () => {
    const { sessions, store } = fixture();
    const target = run();
    sessions.appendEvent({
      session_id: "parent-1", ts: 1, kind: "inject",
      payload: { text: DECOMPOSE_PROMPT, source: `taskflow:${target.id}:decompose` },
    });

    expect(await injectDecompositionWhenMissing({ run: target, sessions, store })).toBe(false);
  });

  it("holds the prompt back while the session has an unanswered question", async () => {
    const { sessions, store } = fixture();
    const target = run();

    expect(await injectDecompositionWhenMissing({
      run: target, sessions, store, hasPendingQuestion: () => true,
    })).toBe(false);
    // Not marked as injected: it is sent once the question is answered.
    expect(await injectDecompositionWhenMissing({ run: target, sessions, store })).toBe(true);
  });

  it("falls back to the child session's repository and skips a run without one", async () => {
    const { sessions, store, findForProject } = fixture();
    sessions.insertSession({
      id: "child-1", provider: "claude-code", repo_path: "E:/Document/Ars/Ergo", repo_origin: null, branch: "main",
      host: "h", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null,
    });

    expect(await injectDecompositionWhenMissing({
      run: run({ args_json: "{}", child_session_id: "child-1" }), sessions, store,
    })).toBe(true);
    expect(findForProject).toHaveBeenCalledWith("E:/Document/Ars/Ergo", ["pending", "delegated"], null);

    expect(await injectDecompositionWhenMissing({ run: run({ args_json: "not json" }), sessions, store })).toBe(false);
  });
});
