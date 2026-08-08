/**
 * @implements spec/feature/operational-log-lifecycle.md — 診断ノイズの抑制
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { TaskMdStore } from "./md-store.js";
import { TaskflowStateStore } from "./state-store.js";
import { applyMigrations } from "../db/schema.js";
import { reconcileTaskDocuments } from "./reconcile.js";

// vitest は `isolate: false` で module registry を共有するため、 別のテストが先に
// md-store を読み込んでいると `vi.mock("../shared/logger.js")` は効かない。
// logger は TaskMdStore に注入して読み込み順から切り離す。
const warn = vi.fn();

describe("TaskMdStore.scan", () => {
  let root: string;
  let tasksDir: string;
  let broken: string;

  beforeEach(async () => {
    warn.mockClear();
    root = await mkdtemp(join(tmpdir(), "concordia-md-store-"));
    const repoPath = join(root, "ConcordiaFixture");
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
    const original = `${validTaskMarkdown().replace("memoria_task_id: null", "status: pending\nmemoria_task_id: null")}`;
    await writeFile(taskPath, original, "utf8");
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskMdStore(() => [root], { warn }, new TaskflowStateStore(db));

    await reconcileTaskDocuments(store, { createTask: async () => ({ id: 77 }) });

    expect(await readFile(taskPath, "utf8")).toBe(original);
    expect(db.prepare("SELECT memoria_task_id FROM taskflow_task_state").get()).toMatchObject({ memoria_task_id: "77" });
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
