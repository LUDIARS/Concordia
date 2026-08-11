import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildSessionTaskPrContent, loadSessionTaskPrContent } from "./session-task-pr-content.js";
import type { TaskDocument } from "../taskflow/md-store.js";

function task(overrides: Partial<TaskDocument> = {}): TaskDocument {
  return {
    path: "E:/Document/Ars/Concordia/spec/tasks/pr-content.md",
    repoPath: "E:/Document/Ars/Concordia",
    title: "PR 内容の構造化契約を追加する",
    body: [
      "# PR 内容の構造化契約を追加する",
      "",
      "## 目的",
      "タスクの設計を PR 本文として読めるようにする。",
      "",
      "## 完了条件",
      "- 実装内容と受け入れ条件を分けて提出する。",
      "",
      "## スコープ",
      "- src/pr 配下だけを変更する。",
    ].join("\n"),
    frontmatter: {
      task: "pr-content-contract",
      project: "Concordia",
      kind: "実装",
      status: "pending",
      created: "2026-08-08",
      source_session: "session-1",
      memoria_task_id: null,
    },
    ...overrides,
  };
}

describe("loadSessionTaskPrContent", () => {
  it("loads task markdown from the submitted worktree", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "session-task-pr-"));
    try {
      const tasksDir = join(repoPath, "spec", "tasks");
      await mkdir(tasksDir, { recursive: true });
      await writeFile(join(tasksDir, "task.md"), [
        "---",
        "task: pr-content-contract",
        "project: Concordia",
        "kind: 実装",
        "status: pending",
        "created: 2026-08-08",
        "source_session: session-1",
        "memoria_task_id: null",
        "---",
        "# PR 内容を構造化する",
        "",
        "## 目的",
        "設計を PR 本文へ写す。",
        "",
        "## 完了条件",
        "- 受け入れ条件を独立して表示する。",
      ].join("\n"), "utf8");

      const content = await loadSessionTaskPrContent(repoPath, "session-1");

      expect(content.title).toBe("PR 内容を構造化する");
      expect(content.body).toContain("設計を PR 本文へ写す。");
      expect(content.body).toContain("受け入れ条件を独立して表示する。");
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});

describe("buildSessionTaskPrContent", () => {
  it("copies the designed task into separate implementation and acceptance sections", () => {
    const content = buildSessionTaskPrContent([task()], "session-1");

    expect(content.title).toBe("PR 内容の構造化契約を追加する");
    expect(content.body).toContain("## 実装内容");
    expect(content.body).toContain("タスクの設計を PR 本文として読めるようにする。");
    expect(content.body).toContain("## 受け入れ条件");
    expect(content.body).toContain("実装内容と受け入れ条件を分けて提出する。");
    expect(content.body).not.toMatch(/## 実装内容[\s\S]*## 完了条件/);
  });

  it("does not borrow a task designed for another session", () => {
    const content = buildSessionTaskPrContent([task()], "session-2");

    expect(content.title).toBe("PR 内容未登録");
    expect(content.body).toBe("## 実装内容\n\n## 受け入れ条件");
  });

  it("ignores a task whose deserialized source_session is not a string", () => {
    const document = task();
    const content = buildSessionTaskPrContent([{
      ...document,
      frontmatter: { ...document.frontmatter, source_session: 123 as unknown as string },
    }], "session-1");

    expect(content.title).toBe("PR 内容未登録");
    expect(content.body).toBe("## 実装内容\n\n## 受け入れ条件");
  });

  it("leaves the acceptance section empty when the task has no completion criteria", () => {
    const content = buildSessionTaskPrContent([
      task({ body: "\n# PR 内容の構造化契約を追加する\n\n## 目的\n本文を構造化する。" }),
    ], "session-1");

    expect(content.body).toBe("## 実装内容\n### PR 内容の構造化契約を追加する\n## 目的\n本文を構造化する。\n\n## 受け入れ条件");
  });

  it("does not accept a multi-task PR when even one task lacks completion criteria", () => {
    const content = buildSessionTaskPrContent([
      task(),
      task({
        title: "表示項目を追加する",
        body: "# 表示項目を追加する\n\n## 目的\n内容を表示する。",
      }),
    ], "session-1");

    expect(content.body).toMatch(/## 受け入れ条件$/);
  });

  it("moves every acceptance alias out of the implementation section", () => {
    const content = buildSessionTaskPrContent([
      task({
        body: [
          "# PR 内容の構造化契約を追加する",
          "",
          "## 目的",
          "本文を構造化する。",
          "",
          "## 完了条件",
          "- 条件 A",
          "",
          "## 受け入れ条件",
          "- 条件 B",
          "",
          "## スコープ",
          "- src/pr 配下",
        ].join("\n"),
      }),
    ], "session-1");

    expect(content.body.match(/^## 受け入れ条件$/gm)).toHaveLength(1);
    expect(content.body).toContain("- 条件 A\n\n- 条件 B");
    expect(content.body.indexOf("- 条件 A")).toBeGreaterThan(content.body.indexOf("## 受け入れ条件"));
  });

  it("preserves the existing 200-character PR title limit", () => {
    const content = buildSessionTaskPrContent([task({ title: "題".repeat(201) })], "session-1");

    expect(content.title).toHaveLength(200);
  });
});
