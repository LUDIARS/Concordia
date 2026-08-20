/**
 * director-patrol と workflow.director の対応を定義する。
 *
 * @implements spec/feature/director-patrol.md §1 — workflow binding key `director`
 *
 * morning-binding と同じ形: bootstrap の起動依存は受け取った start 関数へ閉じ込め、
 * 割当だけを単体テストできるようにする。巡回の寿命は cron (daily) とも朝タスク
 * (morning) とも独立に切り替えられる。
 */

import type { WorkflowBinding } from "./binding-registry.js";

export function createDirectorPatrolBinding(
  start: WorkflowBinding["start"],
): WorkflowBinding {
  return {
    key: "director",
    name: "director-patrol",
    start,
  };
}
