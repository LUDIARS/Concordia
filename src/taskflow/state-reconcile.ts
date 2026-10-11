/**
 * 状態の写しの照合 (spec/feature/task-workflow-v3.md §状態の写し)。
 *
 * taskflow_task_state.status は Actio を読んだ結果のキャッシュ。正本は Actio なので、
 * Actio を読むだけで (書き込まない)、食い違った Cc 側の列を Actio に合わせる。
 * 定期実行 (bootstrap) と移行手順 M6 (dry-run で一覧だけ出す) の両方が使う。
 */
import type { TaskDocument, TaskStatus } from "./types.js";

export interface StatusDrift {
  repoPath: string;
  reference: string;
  from: TaskStatus | null;
  to: TaskStatus;
}

export interface StatusReconcilePorts {
  /** Actio の task 一覧。runtime.status が Actio の現状態。 */
  scan(): Promise<TaskDocument[]>;
  /** Cc に残っている写し。行が無ければ null。 */
  cached(repoPath: string, reference: string): TaskStatus | null;
  write(drift: StatusDrift): void;
}

export function findStatusDrift(
  documents: readonly TaskDocument[], cached: StatusReconcilePorts["cached"],
): StatusDrift[] {
  const drift: StatusDrift[] = [];
  for (const document of documents) {
    const to = document.runtime?.status;
    if (!to || !document.path.startsWith("actio:")) continue;
    const from = cached(document.repoPath, document.path);
    if (from !== to) drift.push({ repoPath: document.repoPath, reference: document.path, from, to });
  }
  return drift;
}

/** apply=false は一覧だけを返す (dry-run)。 */
export async function reconcileTaskStatuses(
  ports: StatusReconcilePorts, options: { apply: boolean },
): Promise<{ checked: number; drift: StatusDrift[]; applied: boolean }> {
  const documents = await ports.scan();
  const drift = findStatusDrift(documents, ports.cached);
  if (options.apply) for (const item of drift) ports.write(item);
  return { checked: documents.length, drift, applied: options.apply };
}
