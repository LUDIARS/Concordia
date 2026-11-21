import type { ProviderTerminal, ResourceRelease } from "./execution-adapter.js";
import type { SiteReceipt } from "./colab-site-schema.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:1da0f770 */
import augurContract_cc84ed1c from './colab-site-evidence.contract.js'; /* augur-inject:contract-predicate:ad4026ba */
import augurContract_0c338781 from './colab-site-action.contract.js'; /* augur-inject:contract-predicate:48a2fb33 */

export function siteJobAction(state: {
  allocation: string; jobId?: string; stopRequested: boolean; cancelSent: boolean;
}, initial: boolean): "submit" | "hold" | "cancel" | "observe" {
  if (!state.jobId) return initial && !state.stopRequested && state.allocation === "unattempted" ? "submit" : "hold";
  return state.stopRequested && !state.cancelSent ? "cancel" : "observe";
}
// @ts-expect-error augur-inject
siteJobAction = contract(siteJobAction, { ...augurContract_0c338781, contractId: 'cloud-colab-site-C-40', mode: 'observe', sample: 1, where: 'src/cloud-work/colab-site-policy.ts:4', rule: 'contract-wrap', id: '0c338781' }); /* augur-inject:contract-wrap:0c338781 */

export function siteJobEvidence(receipt: SiteReceipt, stopRequested: boolean): {
  providerTerminal: ProviderTerminal; resourceRelease: ResourceRelease; stopProgress: "none" | "requested" | "confirmed";
} {
  const released = receipt.phase === "released";
  const stopped = released && receipt.outcome === "cancelled";
  let providerTerminal: ProviderTerminal = "unknown";
  if (receipt.outcome === "completed") providerTerminal = "succeeded";
  else if (receipt.outcome === "failed" || receipt.outcome === "deadline" || receipt.outcome === "interrupted") providerTerminal = "failed";
  else if (stopped) providerTerminal = "cancelled";
  else if (!receipt.outcome && (receipt.phase === "executing" || receipt.phase === "collecting")) providerTerminal = "running";
  return { providerTerminal, resourceRelease: released ? "released" : "unknown",
    stopProgress: stopped ? "confirmed" : stopRequested ? "requested" : "none" };
}
// @ts-expect-error augur-inject
siteJobEvidence = contract(siteJobEvidence, { ...augurContract_cc84ed1c, contractId: 'cloud-colab-site-C-38', mode: 'observe', sample: 1, where: 'src/cloud-work/colab-site-policy.ts:11', rule: 'contract-wrap', id: 'cc84ed1c' }); /* augur-inject:contract-wrap:cc84ed1c */
