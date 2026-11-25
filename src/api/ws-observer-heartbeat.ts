import { toWsEventFrame, type WsConcordiaEventFrame } from "../shared/event-schema.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:6eebeff1 */
import augurContract_7e2f0db8 from './ws-observer-heartbeat.contract.js'; /* augur-inject:contract-predicate:93cdce63 */

export function toWsObserverHeartbeat(sessionId: string | null, ts: number): WsConcordiaEventFrame | null {
  return sessionId === null ? toWsEventFrame({ type: "ping", ts }) : null;
}
// @ts-expect-error augur-inject
toWsObserverHeartbeat = contract(toWsObserverHeartbeat, { ...augurContract_7e2f0db8, contractId: 'web-idle-C-1', mode: 'observe', sample: 1, where: 'src/api/ws-observer-heartbeat.ts:3', rule: 'contract-wrap', id: '7e2f0db8' }); /* augur-inject:contract-wrap:7e2f0db8 */
