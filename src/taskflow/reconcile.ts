import type { TaskBackend } from "./backend.js";
import type { TaskMdStore } from "./md-store.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("taskflow/reconcile");

export async function reconcileTaskDocuments(store: TaskMdStore, backend: TaskBackend): Promise<number> {
  let created = 0;
  for (const document of await store.scan()) {
    if (document.frontmatter.status !== "pending" || document.frontmatter.memoria_task_id != null) continue;
    try {
      const task = await backend.createTask({
        title: document.title,
        details: `${document.body.trim()}\n\nsource: ${store.relativePath(document)}`.trim(),
        category: document.frontmatter.kind,
      });
      await store.updateMemoriaTaskId(document, task.id);
      created += 1;
    } catch (error) {
      log.warn({ path: document.path, error: (error as Error).message }, "task reconcile failed; retrying next tick");
    }
  }
  return created;
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
