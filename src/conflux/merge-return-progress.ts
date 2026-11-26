/**
 * Read-only projection of a merge playtest return record for the control API.
 *
 * The ledger's `status` records the intake decision (queued / skipped) and is never rewritten.
 * The Muse instruction (agent_instructions), the Conflux build (conflux build jobs) and the
 * result relay (muse_playtest_relays) each own their own progress; this module only reads them
 * and keeps the four facets side by side. Instruction bodies, result summaries/details and relay
 * errors are not projected (no new disclosure).
 *
 * @implements spec/feature/merge-playtest-return.md — CC-RET-INV-04 / CC-RET-INV-06
 */
import type { InstructionStatus } from "../agent-instructions/instruction-policy.js";
import { mergeReturnBuildMode, type MergeReturnRecord } from "./merge-return-repository.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:5f66a896 */
import augurContract_0edbaa77 from './merge-return-progress.contract.js'; /* augur-inject:contract-predicate:68ab2cfd */

/** waiting = pending (not yet received), running = acked, unknown = the linked instruction cannot be read. */
export type MergeReturnInstructionState = "waiting" | "running" | "done" | "failed" | "unknown";

export interface MergeReturnInstructionLookup {
  status: InstructionStatus | string;
  finishedAt: string | null;
}

export interface MergeReturnRelayLookup {
  voluptasState: string;
  announceState: string;
}

export interface MergeReturnRelayState {
  voluptas_state: string;
  announce_state: string;
}

export interface MergeReturnProgressLookups {
  buildStatus(buildKey: string): string | null;
  instruction(id: string): MergeReturnInstructionLookup | null;
  relay?: ((instructionId: string) => MergeReturnRelayLookup | null) | undefined;
}

export type MergeReturnView = MergeReturnRecord & {
  build_mode: "conflux" | "agent" | null;
  build_status: string | null;
  /** null: no instruction was dispatched for this record. */
  instruction_state: MergeReturnInstructionState | null;
  instruction_finished_at: string | null;
  /** null: no relay row (not finished, not a relayed result, or the relay is not wired). */
  relay: MergeReturnRelayState | null;
};

const STATE_OF: Readonly<Record<string, MergeReturnInstructionState>> = {
  pending: "waiting", acked: "running", done: "done", failed: "failed",
};

export function mergeReturnInstructionState(
  instructionId: string | null, instruction: MergeReturnInstructionLookup | null,
): MergeReturnInstructionState | null {
  if (instructionId === null) return null;
  if (instruction === null) return "unknown";
  return STATE_OF[instruction.status] ?? "unknown";
}
// @ts-expect-error augur-inject
mergeReturnInstructionState = contract(mergeReturnInstructionState, { ...augurContract_0edbaa77, contractId: 'gen5-return-C-5', mode: 'observe', sample: 1, where: 'src/conflux/merge-return-progress.ts:53', rule: 'contract-wrap', id: '0edbaa77' }); /* augur-inject:contract-wrap:0edbaa77 */

function safely<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

export function projectMergeReturn(record: MergeReturnRecord, lookups: MergeReturnProgressLookups): MergeReturnView {
  const id = record.instruction_id;
  const instruction = id ? safely(() => lookups.instruction(id)) : null;
  const state = mergeReturnInstructionState(id, instruction);
  const relayRow = id && state === "done" && lookups.relay ? safely(() => lookups.relay!(id)) : null;
  return {
    ...record,
    build_mode: mergeReturnBuildMode(record),
    build_status: record.build_key ? lookups.buildStatus(record.build_key) : null,
    instruction_state: state,
    instruction_finished_at: state === "done" || state === "failed" ? instruction?.finishedAt ?? null : null,
    relay: relayRow ? { voluptas_state: relayRow.voluptasState, announce_state: relayRow.announceState } : null,
  };
}
