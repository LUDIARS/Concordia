import { contract } from './ontime-runtime.js'; /* augur-inject:import:6be9d2e2 */
import augurContract_2168f9f3 from './session-event-discord-policy.contract.js'; /* augur-inject:contract-predicate:7d567a63 */
/**
 * Which session events the Discord bot must not post.
 *
 * The events stay on the event bus (WS / Web UI subscribers still receive them);
 * only the Discord delivery boundary drops them. Pure: no transport, no state.
 *
 * - session.stall_nudged: the stall-nudge inject itself is still sent to the session,
 *   but the "🔔 [自動確認] ..." notice is never posted to Discord (2026-11-19 neco 指示).
 */
const DISCORD_SILENT_EVENT_TYPES: ReadonlySet<string> = new Set(["session.stall_nudged"]);

export function isDiscordSilentEvent(type: string): boolean {
  return DISCORD_SILENT_EVENT_TYPES.has(type);
}
// @ts-expect-error augur-inject
isDiscordSilentEvent = contract(isDiscordSilentEvent, { ...augurContract_2168f9f3, contractId: 'stall-discord-C-1', mode: 'observe', sample: 1, where: 'src/discord/session-event-discord-policy.ts:12', rule: 'contract-wrap', id: '2168f9f3' }); /* augur-inject:contract-wrap:2168f9f3 */
