import { TaskCreationError, type TaskBackend } from "./backend.js";
import type { TaskMdStore } from "./md-store.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("taskflow/reconcile");

/** @implements spec/feature/task-workflow.md — 2.2 登録 (reconcile) */
export async function reconcileTaskDocuments(store: TaskMdStore, backend: TaskBackend): Promise<number> {
  let created = 0;
  for (const document of await store.scan()) {
    const runtime = document.runtime;
    if (!runtime) throw new Error("taskflow runtime state store is required for reconciliation");
    if (runtime.status !== "pending" || runtime.memoria_task_id !== null) continue;
    if (!store.claimMemoriaCreation(document)) continue;
    let task: { id: string | number };
    try {
      task = await backend.createTask({
        title: document.title,
        details: `${document.body.trim()}\n\nsource: ${store.relativePath(document)}`.trim(),
        category: document.frontmatter.kind,
      });
    } catch (error) {
      if (error instanceof TaskCreationError && error.outcome === "not-created") {
        store.releaseMemoriaCreation(document);
        log.warn({ path: document.path, error: error.message }, "task reconcile failed before reaching Memoria; released creation claim for retry");
        continue;
      }
      log.warn({ path: document.path, error: errorMessage(error) }, "task reconcile outcome is unknown; preserving creation claim to prevent duplicate Memoria tasks");
      continue;
    }
    try {
      store.recordMemoriaTaskId(document, task.id);
      created += 1;
    } catch (error) {
      log.warn({ path: document.path, error: errorMessage(error) }, "Memoria task was created but its ID could not be persisted; preserving creation claim");
    }
  }
  return created;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startTaskReconciler(input: { store: TaskMdStore; backend: TaskBackend; intervalMs?: number }): { stop(): void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await reconcileTaskDocuments(input.store, input.backend); } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), input.intervalMs ?? 60_000);
  timer.unref?.();
  void tick();
  return { stop: () => clearInterval(timer) };
}
