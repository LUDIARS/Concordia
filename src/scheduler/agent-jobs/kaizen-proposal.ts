/** @implements CC-PT-AGENT-INV-07 */
import { scrubText } from "../agent-dispatch-policy.js";
import { contract } from '../ontime-runtime.js'; /* augur-inject:import:cc82b842 */
import augurContract_7892eb85 from './kaizen-proposal.contract.js'; /* augur-inject:contract-predicate:3997e68a */

export const KAIZEN_MAX_PROPOSALS = 20;

interface Proposal {
  title: string;
  reason: string;
  project: string;
}

export type KaizenProposal = { kind: "rejected" }
  | (Proposal & { kind: "human_judgment" })
  | (Proposal & { kind: "cloud_fix"; instruction: string });

function boundedText(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.length <= limit && value.trim()
    ? scrubText(value.trim()) : null;
}

export function assessKaizenProposal(raw: unknown, registered: ReadonlySet<string>): KaizenProposal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "rejected" };
  const { title, reason, target_repo, kind, instruction } = raw as Record<string, unknown>;
  const name = boundedText(title, 120);
  const why = boundedText(reason, 500);
  if (!name || !why || typeof target_repo !== "string" || !registered.has(target_repo)) return { kind: "rejected" };
  const proposal = { title: name, reason: why, project: target_repo };
  if (kind === "human_judgment") return { ...proposal, kind };
  const task = boundedText(instruction, 3000);
  return kind === "cloud_fix" && task ? { ...proposal, kind, instruction: task } : { kind: "rejected" };
}
// @ts-expect-error augur-inject
assessKaizenProposal = contract(assessKaizenProposal, { ...augurContract_7892eb85, contractId: 'cron-kaizen-cloud-C-51', mode: 'observe', sample: 1, where: 'src/scheduler/agent-jobs/kaizen-proposal.ts:22', rule: 'contract-wrap', id: '7892eb85' }); /* augur-inject:contract-wrap:7892eb85 */
