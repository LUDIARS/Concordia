import type { ActioBinding } from "./actio-binding.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:14785163 */
import augurContract_561cd9dc from './actio-team-teamless.contract.js'; /* augur-inject:contract-predicate:f85f12fa */
import augurContract_a9e60c3d from './actio-team-explicit.contract.js'; /* augur-inject:contract-predicate:6bac7750 */
import augurContract_34bf4591 from './actio-team-registered.contract.js'; /* augur-inject:contract-predicate:351bcd21 */

/** Raised when a requested team is outside the project's Actio registration. */
export class ActioTeamSelectionError extends Error {
  constructor(readonly candidateTeamIds: readonly string[]) {
    super("Actio team is not registered for the project");
  }
}

/** Teams a task under this binding may legitimately belong to. */
export function bindingTeamCandidates(binding: Pick<ActioBinding, "teamId" | "teamCandidates">): string[] {
  return binding.teamId !== null ? [binding.teamId] : [...(binding.teamCandidates ?? [])];
}

/**
 * Pure policy: only an explicitly requested, registered team is used. Without a
 * request the binding is unchanged (a multi-team project stays team-less).
 */
export function selectActioTeam(binding: ActioBinding, requestedTeamId?: string | null): ActioBinding {
  if (!requestedTeamId) return binding;
  if (binding.teamId === requestedTeamId) return binding;
  // A configured or single-team binding already fixes the team; never override it.
  if (binding.teamId === null && binding.teamCandidates?.includes(requestedTeamId)) {
    return { ...binding, teamId: requestedTeamId };
  }
  throw new ActioTeamSelectionError(bindingTeamCandidates(binding));
}
// @ts-expect-error augur-inject
selectActioTeam = contract(selectActioTeam, { ...augurContract_34bf4591, contractId: 'actio-team-C-4', mode: 'observe', sample: 1, where: 'src/taskflow/actio-team-selection.ts:19', rule: 'contract-wrap', id: '34bf4591' }); /* augur-inject:contract-wrap:34bf4591 */
// @ts-expect-error augur-inject
selectActioTeam = contract(selectActioTeam, { ...augurContract_a9e60c3d, contractId: 'actio-team-C-3', mode: 'observe', sample: 1, where: 'src/taskflow/actio-team-selection.ts:19', rule: 'contract-wrap', id: 'a9e60c3d' }); /* augur-inject:contract-wrap:a9e60c3d */
// @ts-expect-error augur-inject
selectActioTeam = contract(selectActioTeam, { ...augurContract_561cd9dc, contractId: 'actio-team-C-2', mode: 'observe', sample: 1, where: 'src/taskflow/actio-team-selection.ts:19', rule: 'contract-wrap', id: '561cd9dc' }); /* augur-inject:contract-wrap:561cd9dc */

/** A task read through a team-less multi-team binding may belong to any registered team. */
export function taskTeamInScope(binding: Pick<ActioBinding, "teamId" | "teamCandidates">, taskTeamId: string | null): boolean {
  if (taskTeamId === binding.teamId) return true;
  return binding.teamId === null && taskTeamId !== null && (binding.teamCandidates?.includes(taskTeamId) ?? false);
}

/**
 * Keeps the original message (so failure.ts still classifies it) and adds the
 * registered teams a caller may name instead of a team-less task.
 */
export class ActioTeamCandidatesError extends Error {
  constructor(message: string, readonly candidateTeamIds: readonly string[]) { super(message); }
}

/** Reads candidates attached by this module; any other error has none. */
export function failureTeamCandidates(error: unknown): readonly string[] {
  return error instanceof ActioTeamSelectionError || error instanceof ActioTeamCandidatesError
    ? error.candidateTeamIds : [];
}
