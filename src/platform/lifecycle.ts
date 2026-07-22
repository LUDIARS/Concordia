export interface LifecycleStep {
  name: string;
  stop(): void | Promise<unknown>;
}

/** Idempotence belongs to the owning adapter; this runner guarantees all cleanup steps are attempted. */
export async function stopLifecycle(
  steps: readonly LifecycleStep[],
  warn: (message: string) => void,
): Promise<void> {
  for (const step of steps) {
    try { await step.stop(); }
    catch (error) { warn(`${step.name} stop failed: ${(error as Error).message}`); }
  }
}
