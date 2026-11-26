import { contract } from './ontime-runtime.js'; /* augur-inject:import:de238a8e */
import augurContract_ef4af9c5 from './actio-read-retry.contract.js'; /* augur-inject:contract-predicate:4d0705aa */
/** @implements spec/feature/taskflow-failure-visibility.md CC-TF-READ-04 */
export function actioReadRetryDelay(
  method: string, reason: string, attempt: number, remainingMs: number, status?: number,
): number | null {
  const delayMs = 150;
  if (method !== "GET" || attempt !== 1 || remainingMs <= delayMs) return null;
  if (reason === "actio_unreachable" || reason === "actio_read_timeout") return delayMs;
  if (reason === "actio_request_rejected" && (status === 502 || status === 503 || status === 504)) return delayMs;
  return null;
}
// @ts-expect-error augur-inject
actioReadRetryDelay = contract(actioReadRetryDelay, { ...augurContract_ef4af9c5, contractId: 'actio-stall-C-151', mode: 'observe', sample: 1, where: 'src/taskflow/actio-read-retry.ts:2', rule: 'contract-wrap', id: 'ef4af9c5' }); /* augur-inject:contract-wrap:ef4af9c5 */
