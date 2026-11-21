import { integrationEvent, type IntegrationBinding } from "./policy.js";
import type { ConfluxRepository } from "./repository.js";

type PullRequest = Parameters<typeof integrationEvent>[1];
type ConfiguredBinding = IntegrationBinding & { prId: string };

export function createConfluxMergePoller(repo: Pick<ConfluxRepository, "hasHook" | "enqueue">, deps: {
  integrations: ConfiguredBinding[];
  pullRequest: (id: string) => Promise<PullRequest | null>;
  onMerged?: (binding: ConfiguredBinding, pr: PullRequest) => boolean;
  discoverMerges?: (signal: AbortSignal) => Promise<void>;
  notify: boolean;
  warn: (message: string) => void;
  now: () => number;
}) {
  let nextCheck = 0;
  const observed = new Set<string>();

  async function checkBinding(binding: ConfiguredBinding, signal: AbortSignal): Promise<void> {
    const key = `integration:${binding.prId}:${binding.decisionId}`;
    const shouldNotify = deps.notify && !repo.hasHook(key);
    const shouldObserve = deps.onMerged && !observed.has(key);
    if (!shouldNotify && !shouldObserve) return;
    try {
      const pr = await deps.pullRequest(binding.prId);
      if (signal.aborted || pr?.id !== binding.prId) return;
      const payload = integrationEvent(binding, pr);
      if (!payload) return;
      if (shouldNotify) repo.enqueue({ key, path: "/api/hooks/integration", payload });
      if (shouldObserve && deps.onMerged?.(binding, pr)) observed.add(key);
    } catch {
      deps.warn("Revisor merge observation unavailable");
    }
  }

  return async (signal: AbortSignal): Promise<void> => {
    if (deps.now() < nextCheck) return;
    nextCheck = deps.now() + 60_000;
    for (const binding of deps.integrations) {
      if (signal.aborted) return;
      await checkBinding(binding, signal);
    }
    if (signal.aborted || !deps.discoverMerges) return;
    try {
      await deps.discoverMerges(signal);
    } catch {
      if (!signal.aborted) deps.warn("Revisor merge list unavailable");
    }
  };
}
