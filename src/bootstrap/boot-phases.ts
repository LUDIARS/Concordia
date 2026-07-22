export interface BootPhase {
  name: string;
  run(): void | Promise<void>;
}

export async function runBootPhases(
  phases: readonly BootPhase[],
  options: { shouldStop(): boolean; onComplete?(name: string, durationMs: number): void },
): Promise<boolean> {
  for (const phase of phases) {
    if (options.shouldStop()) return false;
    const started = Date.now();
    await phase.run();
    options.onComplete?.(phase.name, Date.now() - started);
  }
  return !options.shouldStop();
}
