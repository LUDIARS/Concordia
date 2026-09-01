/**
 * 散歩セッション (curiosity walk) と workflow.curiosity の対応を定義する。
 *
 * @implements spec/feature/curiosity-walk.md §2 — workflow binding key `curiosity`
 *
 * workflow binding の標準形として bootstrap の起動依存は受け取った start 関数へ閉じ込め、
 * 割当だけを単体テストできるようにする。
 */

import type { WorkflowBinding } from "./binding-registry.js";

export function createCuriosityWalkBinding(
  start: WorkflowBinding["start"],
): WorkflowBinding {
  return {
    key: "curiosity",
    name: "curiosity-walk",
    start,
  };
}
