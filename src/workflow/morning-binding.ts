/**
 * morning-scheduler と workflow.morning の対応を定義する。
 *
 * @implements spec/tasks/workflow-toggles.md — morning-scheduler の独立制御
 *
 * bootstrap の起動依存は受け取った start 関数へ閉じ込め、割当だけを単体テストできる
 * 形にする。これにより daily の cron と朝タスクの寿命が再び混ざるのを防ぐ。
 */

import type { WorkflowBinding } from "./binding-registry.js";

export function createMorningSchedulerBinding(
  start: WorkflowBinding["start"],
): WorkflowBinding {
  return {
    key: "morning",
    name: "morning-scheduler",
    start,
  };
}
