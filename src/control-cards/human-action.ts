import { redactSecrets } from "../shared/redact-secrets.js";
import { clipText } from "./card-domain.js";
import { neutralizeMentions } from "./reminder-policy.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:82647771 */
import augurContract_6c699606 from './human-action.contract.js'; /* augur-inject:contract-predicate:46e51e5c */

export const HUMAN_ACTION_MAX_CHARS = 80;

/** 秘密やメンションを取り除いてから表示用の一行に収める。 */
export function normalizeHumanAction(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  return clipText(neutralizeMentions(redactSecrets(flat)), HUMAN_ACTION_MAX_CHARS) || null;
}
// @ts-expect-error augur-inject
normalizeHumanAction = contract(normalizeHumanAction, { ...augurContract_6c699606, contractId: 'control-card-action-C-1', mode: 'observe', sample: 1, where: 'src/control-cards/human-action.ts:8', rule: 'contract-wrap', id: '6c699606' }); /* augur-inject:contract-wrap:6c699606 */
