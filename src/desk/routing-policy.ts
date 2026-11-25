import { contract } from './ontime-runtime.js'; /* augur-inject:import:5ac676cd */
import augurContract_906a3dd9 from './routing-policy.contract.js'; /* augur-inject:contract-predicate:1874b8b1 */
import augurContract_94e65023 from './project-control-capacity.contract.js'; /* augur-inject:contract-predicate:643e81ce */
/** @implements CC-DESK — Actio による依頼の割り当て */
export interface ProjectControlSession {
  id: string;
  spawnId: string | null;
  idle: boolean;
}

export function currentProjectControl(sessions: readonly ProjectControlSession[], spawnId: string | null): ProjectControlSession | null {
  if (!spawnId) return null;
  const matching = sessions.filter((session) => session.spawnId === spawnId);
  return matching.length === 1 ? matching[0] ?? null : null;
}
// @ts-expect-error augur-inject
currentProjectControl = contract(currentProjectControl, { ...augurContract_906a3dd9, contractId: 'desk-routing-C-1', mode: 'observe', sample: 1, where: 'src/desk/routing-policy.ts:8', rule: 'contract-wrap', id: '906a3dd9' }); /* augur-inject:contract-wrap:906a3dd9 */

export const PROJECT_CONTROL_DELEGATION_LIMIT = 2;

export function canOfferDeskRequest(occupied: number): boolean {
  return occupied < PROJECT_CONTROL_DELEGATION_LIMIT;
}
// @ts-expect-error augur-inject
canOfferDeskRequest = contract(canOfferDeskRequest, { ...augurContract_94e65023, contractId: 'desk-routing-C-2', mode: 'observe', sample: 1, where: 'src/desk/routing-policy.ts:16', rule: 'contract-wrap', id: '94e65023' }); /* augur-inject:contract-wrap:94e65023 */

export interface DeskProject {
  code: string;
  name: string;
  repoPath: string;
}

export function resolveDeskProject(body: string, projects: readonly DeskProject[], override?: string | null): DeskProject | null {
  const explicit = override || /^\s*\[([^\]\r\n]+)\]/u.exec(body)?.[1]?.trim().toLowerCase();
  const words = new Set(body.toLowerCase().match(/[\p{L}\p{N}_.-]+/gu) ?? []);
  const matches = projects.filter(({ code, name }) => [code, name].some((alias) => {
    const key = alias.toLowerCase();
    return explicit ? key === explicit : words.has(key);
  }));
  return matches.length === 1 ? matches[0]! : null;
}

export function deskTaskTitle(body: string): string {
  return Array.from(body.trim().split(/\r?\n/u, 1)[0] ?? "").slice(0, 120).join("");
}
