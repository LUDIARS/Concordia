/**
 * プラン承認時にセッションへ送る指示が、task md の保存ではなく Actio 登録を求めるかの検証。
 *
 * @implements spec/feature/task-workflow-v3.md — Plan approval
 */

import { describe, expect, it } from "vitest";
import { planApprovedInstruction } from "./task-instructions.js";

describe("planApprovedInstruction", () => {
  const text = planApprovedInstruction("## タスク分解\n- A を直す");

  it("タスク分解節を Actio へ登録させる", () => {
    expect(text).toContain("Actio に登録");
    expect(text).toContain("POST /v1/taskflow/tasks");
    expect(text).toContain("## タスク分解\n- A を直す");
  });

  it("spec/tasks/ への task md 保存を指示しない", () => {
    expect(text).not.toContain("spec/tasks");
    expect(text).not.toContain("task md");
    expect(text).not.toContain("taskflow reconciler");
  });
});
