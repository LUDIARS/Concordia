import type { TaskStore } from "../taskflow/store.js";
import type { CloudScope } from "./runtime-service.js";

/**
 * クラウド実行の起動前に、参照先のタスクがその範囲に実在する (必要なら未完了である) ことを確かめる。
 * runtime.ts / aws-runtime.ts / colab-runtime.ts が共有する。module runtime から切り離しておくのは、
 * runtime.ts を import できるのは組み立て点だけ (module-runtime-composition-only) だから。
 */
export function cloudTaskAuthorizer(tasks: TaskStore) {
  return async (reference: string, scope: CloudScope, requireActive?: boolean): Promise<void> => {
    if (!tasks.read) throw new Error("cloud_task_store_unavailable");
    const task = await tasks.read(scope.repositoryKey, reference, scope.subsidiaryId);
    if (requireActive && ["done", "cancelled"].includes(task.runtime?.status ?? "")) throw new Error("cloud_task_not_active");
  };
}
