/**
 * @implements spec/feature/operational-log-lifecycle.md — 診断ノイズの抑制
 * @implements spec/feature/task-workflow.md — 2.1 md 正本 / 2.2 登録 (reconcile)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { parseTaskMarkdown, TaskMdStore } from "./md-store.js";
import { TaskflowStateStore } from "./state-store.js";
import { applyMigrations } from "../db/schema.js";
import { reconcileTaskDocuments } from "./reconcile.js";
import { TaskCreationError } from "./backend.js";

// vitest は `isolate: false` で module registry を共有するため、 別のテストが先に
// md-store を読み込んでいると `vi.mock("../shared/logger.js")` は効かない。
// logger は TaskMdStore に注入して読み込み順から切り離す。
const warn = vi.fn();

describe("TaskMdStore.scan", () => {
  let root: string;
  let repoPath: string;
  let tasksDir: string;
  let broken: string;

  beforeEach(async () => {
    warn.mockClear();
    root = await mkdtemp(join(tmpdir(), "concordia-md-store-"));
    repoPath = join(root, "ConcordiaFixture");
    tasksDir = join(repoPath, "spec", "tasks");
    broken = join(tasksDir, "broken.md");

    await mkdir(join(repoPath, ".git"), { recursive: true });
    await mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("同じ壊れた md は再スキャンしても 1 回しか warn しない", async () => {
    await writeFile(broken, "broken markdown", "utf8");
    const store = new TaskMdStore(() => [root], { warn });

    expect(await store.scan()).toHaveLength(0);
    expect(await store.scan()).toHaveLength(0);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ path: broken });
  });

  it("frontmatter の yaml が壊れていても 1 回しか warn しない", async () => {
    // yaml.load が throw する経路。 parseTaskMarkdown が自分で log しないことの回帰テスト。
    await writeFile(broken, "---\ntask: [unclosed\n---\n# Broken\n", "utf8");
    const store = new TaskMdStore(() => [root], { warn });

    expect(await store.scan()).toHaveLength(0);
    expect(await store.scan()).toHaveLength(0);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toBe("invalid task frontmatter skipped");
  });

  it("keeps an unquoted created date in the static definition as a string", () => {
    expect(parseTaskMarkdown(validTaskMarkdown())?.frontmatter.created).toBe("2026-08-03");
  });

  it("rejects incomplete frontmatter and malformed memory links", () => {
    expect(parseTaskMarkdown(validTaskMarkdown().replace("task: fixture", "task:  "))).toBeNull();
    expect(parseTaskMarkdown(validTaskMarkdown().replace(
      "memoria_task_id: null",
      "memory_links: [valid, '']",
    ))).toBeNull();
  });

  it("invalid legacy status is skipped instead of becoming a pending task", async () => {
    await writeFile(broken, validTaskMarkdown().replace("status: pending", "status: paused"), "utf8");
    const store = new TaskMdStore(() => [root], { warn });

    expect(await store.scan()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ error: "legacy task status is invalid" });
  });

  it("finds one task by its validated relative path and uses runtime status", async () => {
    const taskPath = join(tasksDir, "current.md");
    await writeFile(taskPath, validTaskMarkdown(), "utf8");
    const db = new Database(":memory:");
    applyMigrations(db);
    const state = new TaskflowStateStore(db);
    const store = new TaskMdStore(() => [root], { warn }, state);
    await store.scan();
    state.update({ repoPath, taskPath: "spec/tasks/current.md" }, { status: "done" });

    expect(await store.findByRelativePath(repoPath, "spec/tasks/current.md")).toEqual({ status: "done" });
    expect(await store.findByRelativePath(repoPath, "spec/tasks/../outside.md")).toBeNull();
    db.close();
  });

  it("直った md は抑制を解除し、再度壊れたらまた warn する", async () => {
    await writeFile(broken, "broken markdown", "utf8");
    const store = new TaskMdStore(() => [root], { warn });

    await store.scan();
    await writeFile(broken, validTaskMarkdown(), "utf8");
    expect(await store.scan()).toHaveLength(1);
    await writeFile(broken, "broken again", "utf8");
    await store.scan();

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("reconciliation migrates legacy state without rewriting Markdown bytes", async () => {
    const taskPath = join(tasksDir, "legacy.md");
    const original = validTaskMarkdown();
    await writeFile(taskPath, original, "utf8");
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskMdStore(() => [root], { warn }, new TaskflowStateStore(db));

    await reconcileTaskDocuments(store, { createTask: async () => ({ id: 77 }) });

    expect(await readFile(taskPath, "utf8")).toBe(original);
    expect(db.prepare("SELECT memoria_task_id FROM taskflow_task_state").get()).toMatchObject({ memoria_task_id: "77" });
  });

  it("retries only when task creation definitely failed before reaching Memoria", async () => {
    await writeFile(join(tasksDir, "retry.md"), validTaskMarkdown(), "utf8");
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskMdStore(() => [root], { warn }, new TaskflowStateStore(db));

    await reconcileTaskDocuments(store, {
      createTask: async () => { throw new TaskCreationError("not-created", new Error("connection refused")); },
    });
    expect(db.prepare("SELECT memoria_registration_state FROM taskflow_task_state").get())
      .toEqual({ memoria_registration_state: "idle" });

    expect(await reconcileTaskDocuments(store, { createTask: async () => ({ id: 78 }) })).toBe(1);
  });

  it("preserves the claim when task creation may have reached Memoria", async () => {
    await writeFile(join(tasksDir, "unknown.md"), validTaskMarkdown(), "utf8");
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskMdStore(() => [root], { warn }, new TaskflowStateStore(db));
    const createTask = vi.fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ id: 79 });

    expect(await reconcileTaskDocuments(store, { createTask })).toBe(0);
    expect(await reconcileTaskDocuments(store, { createTask })).toBe(0);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT memoria_registration_state FROM taskflow_task_state").get())
      .toEqual({ memoria_registration_state: "creating" });
  });

  it("fails fast when reconciliation is configured without runtime state", async () => {
    await writeFile(join(tasksDir, "missing-state.md"), validTaskMarkdown(), "utf8");
    const store = new TaskMdStore(() => [root], { warn });

    await expect(reconcileTaskDocuments(store, { createTask: async () => ({ id: 80 }) }))
      .rejects.toThrow("runtime state store is required");
  });

  it("does not disguise a runtime state database failure as a Markdown read failure", async () => {
    await writeFile(join(tasksDir, "db-failure.md"), validTaskMarkdown(), "utf8");
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskMdStore(() => [root], { warn }, new TaskflowStateStore(db));
    db.close();

    await expect(store.scan()).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not confuse a path-like workspace root with a child repo of the same name", async () => {
    const workspaceRoot = join(root, "Ars");
    const childRepo = join(workspaceRoot, "ars");
    const childTasks = join(childRepo, "spec", "tasks");
    await mkdir(join(childRepo, ".git"), { recursive: true });
    await mkdir(childTasks, { recursive: true });
    await writeFile(join(childTasks, "child.md"), validTaskMarkdown().replace("ConcordiaFixture", "ars"), "utf8");
    const store = new TaskMdStore(() => [workspaceRoot], { warn });

    expect(await store.findForProject(workspaceRoot)).toHaveLength(0);
    expect(await store.findForProject(`${childRepo.replace(/\\/g, "/")}/./`)).toHaveLength(1);
    expect(await store.findForProject(childRepo.toUpperCase())).toHaveLength(1);
    expect(await store.findForProject("ars")).toHaveLength(1);
    expect(await store.findForProject("LUDIARS/ars")).toHaveLength(1);
  });

  it("reports existing remaining-task files separately from newly created files", async () => {
    const store = new TaskMdStore(() => [root], { warn });
    const input = {
      repoPath,
      sourceRunId: "source-run",
      project: "Concordia",
      remaining: [{ title: "finish API" }],
    };

    const first = await store.writeRemainingTasks(input);
    const second = await store.writeRemainingTasks(input);

    expect(first.created).toHaveLength(1);
    expect(first.existed).toEqual([]);
    expect(second.created).toEqual([]);
    expect(second.existed).toEqual(first.created);
  });

  it("recognises an existing remaining-task file written on a different date", async () => {
    // 進捗なし判定はファイル名の重複で行うため、 日付が変わっても同じ残作業は
    // 「既存」 と読めなければならない (連鎖が UTC 日付をまたぐと再委託が止まらない)。
    const store = new TaskMdStore(() => [root], { warn });
    const input = {
      repoPath,
      sourceRunId: "source-run",
      project: "Concordia",
      remaining: [{ title: "finish API" }],
    };

    const first = await store.writeRemainingTasks(input);
    const yesterday = first.created[0]!.replace(
      /(\d{4}-\d{2}-\d{2})-/,
      "2000-01-01-",
    );
    await rename(first.created[0]!, yesterday);

    const second = await store.writeRemainingTasks(input);

    expect(second.created).toEqual([]);
    expect(second.existed).toEqual([yesterday]);
  });

  it("does not treat an unrelated suffix-matching file as a remaining task", async () => {
    const store = new TaskMdStore(() => [root], { warn });
    await writeFile(join(tasksDir, "backup-source-run-1-finish-api.md"), "not a generated task", "utf8");

    const result = await store.writeRemainingTasks({
      repoPath,
      sourceRunId: "source-run",
      project: "Concordia",
      remaining: [{ title: "finish API" }],
    });

    expect(result.created).toHaveLength(1);
    expect(result.existed).toEqual([]);
  });
});

function validTaskMarkdown(): string {
  return `---
task: fixture
project: ConcordiaFixture
kind: implementation
status: pending
created: 2026-08-03
memoria_task_id: null
---
# Fixture
`;
}
