// @spec ハーネス信頼性の実装境界
/** Process-local counters. Durable evidence remains in Augur's timestamped JSONL report. */
const startedAt = Date.now();
const counters = new Map<string, { contract: string; marker: string; observed: number; violations: number; predicate_errors: number; last_at: number }>();
export function recordContractMetric(message: string, context: Record<string, unknown>): void {
  if (typeof context.contract !== "string" || typeof context.id !== "string") return;
  const key = `${context.contract}:${context.id}`;
  if (!counters.has(key) && counters.size >= 100) return;
  const metric = counters.get(key) ?? { contract: context.contract, marker: context.id, observed: 0, violations: 0, predicate_errors: 0, last_at: 0 };
  if (message === "contract observed") metric.observed++;
  else if (message === "contract violated") metric.violations++;
  else if (message === "contract predicate threw") metric.predicate_errors++;
  else return;
  metric.last_at = Date.now(); counters.set(key, metric);
}
export function contractMetrics() {
  return { scope: "service_process", since: startedAt, contracts: [...counters.values()].map(item => ({ ...item })),
    coverage: "Process-local observations only; restart resets counters. No entry means unobserved. Use Augur JSONL report for period/marker acceptance." };
}
