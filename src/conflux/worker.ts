import type { BuildJob } from "./models.js";
import type { integrationEvent, IntegrationBinding } from "./policy.js";
import { createConfluxMergePoller } from "./merge-poller.js";
import type { ConfluxRepository } from "./repository.js";

type PullRequest = Parameters<typeof integrationEvent>[1];

export function startConfluxWorker(repo: Pick<ConfluxRepository,
  "recoverBuilds" | "claimBuild" | "finishBuild" | "hasHook" | "enqueue" | "pendingHooks" | "finishHook">, deps: {
  runBuild: (job: BuildJob, signal: AbortSignal) => Promise<void>;
  integrations: (IntegrationBinding & { prId: string })[];
  pullRequest: (id: string) => Promise<PullRequest | null>;
  onMerged?: (binding: IntegrationBinding & { prId: string }, pr: PullRequest) => boolean;
  discoverMerges?: (signal: AbortSignal) => Promise<void>;
  hook: { base: string; token: string } | null;
  warn: (message: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  intervalMs?: number;
}) {
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const controller = new AbortController();
  let stopped = false;
  let build: Promise<void> | null = null;
  let delivery: Promise<void> | null = null;
  const pollMerges = createConfluxMergePoller(repo, { ...deps, now, notify: deps.hook !== null });
  repo.recoverBuilds();

  async function runBuild() {
    const job = repo.claimBuild();
    if (!job) return;
    try {
      await deps.runBuild(job, controller.signal);
    } catch {
      repo.finishBuild(job, "failed", "Cc build failed or was interrupted");
      return;
    }
    repo.finishBuild(job, "succeeded");
  }

  async function dispatch() {
    const hook = deps.hook;
    await pollMerges(controller.signal);
    if (stopped || !hook) return;
    for (const item of repo.pendingHooks(now())) {
      if (stopped) break;
      let delivered = false;
      let reason = "transport_error";
      try {
        const response = await send(`${hook.base}${item.path}`, {
          method: "POST", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
          headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${hook.token}` },
          body: item.payload,
        });
        delivered = response.ok;
        if (!delivered) reason = `HTTP ${response.status}`;
        await response.body?.cancel();
      } catch {
        // Retain the original event and retry after backoff on transport failures.
      }
      if (!delivered) deps.warn("Conflux hook delivery failed; event retained");
      const retry = delivered ? undefined : Math.min(60_000 * 2 ** Math.min(item.attempts, 6), 3_600_000);
      repo.finishHook(item.key, now(), retry, delivered ? undefined : reason);
    }
  }

  function tick() {
    if (stopped) return;
    build ??= runBuild().catch(() => deps.warn("Conflux build worker failed")).finally(() => { build = null; });
    delivery ??= dispatch().catch(() => deps.warn("Conflux hook worker failed")).finally(() => { delivery = null; });
  }
  const timer = setInterval(tick, deps.intervalMs ?? 2_000);
  timer.unref();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      controller.abort();
      await Promise.all([build, delivery]);
    },
  };
}
