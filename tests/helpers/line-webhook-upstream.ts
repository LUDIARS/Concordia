import type { RelayInput, RelayOutcome } from "../../src/line-webhook/relay.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:518da3cf */
import augurContract_4c76234d from './line-webhook-upstream.contract.js'; /* augur-inject:contract-predicate:acbfa9c6 */

export interface LineTestUpstream {
  url: string;
  received: Array<{ headers: RelayInput["headers"]; body: Record<string, unknown> }>;
  answer: () => { status: number; body: unknown };
}

export function relayToLineTestUpstream(input: RelayInput, upstream: LineTestUpstream): RelayOutcome {
  const body = JSON.parse(Buffer.from(input.body).toString("utf8")) as Record<string, unknown>;
  upstream.received.push({ headers: input.headers, body });
  const reply = upstream.answer();
  return {
    kind: "response",
    status: reply.status,
    body: Buffer.from(JSON.stringify(reply.body)),
    contentType: "application/json",
  };
}
// @ts-expect-error augur-inject
relayToLineTestUpstream = contract(relayToLineTestUpstream, { ...augurContract_4c76234d, contractId: 'line-relay-test-C-102', mode: 'observe', sample: 1, where: 'tests/helpers/line-webhook-upstream.ts:9', rule: 'contract-wrap', id: '4c76234d' }); /* augur-inject:contract-wrap:4c76234d */
