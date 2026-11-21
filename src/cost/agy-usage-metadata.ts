import { agyInteger, agyMessage, agyString, readAgyVarints, readAgyWire } from "./agy-usage-wire.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:53d29983 */
import augurContract_9ae21ee4 from './agy-usage-metadata.contract.js'; /* augur-inject:contract-predicate:6445ca5e */

export interface AgyGeneration {
  atMs: number | null;
  stepIndex: number | null;
  turnIndex: number | null;
  model: string | null;
  input: number;
  cached: number;
  output: number;
  thinking: number;
  total: number;
}

function timestamp(fields: ReturnType<typeof readAgyWire>): number | null {
  const seconds = agyInteger(fields, 1);
  const nanos = agyInteger(fields, 2) ?? 0;
  if (seconds === null || seconds <= 0 || nanos >= 1e9 || seconds > 253402300799) return null;
  return seconds * 1000 + Math.floor(nanos / 1e6);
}

/** Decode only Google Antigravity's generation metadata, with no prompt or response text. */
export function decodeAgyGeneration(data: Uint8Array): AgyGeneration | null {
  const generator = readAgyWire(data);
  const chatModel = agyMessage(generator, 1);
  const usage = agyMessage(chatModel, 4);
  if (!usage) return null;
  const input = agyInteger(usage, 2) ?? 0;
  const output = agyInteger(usage, 3) ?? 0;
  const cached = agyInteger(usage, 5) ?? 0;
  const thinking = agyInteger(usage, 9) ?? 0;
  const total = input + cached + output;
  if (thinking > output || !Number.isSafeInteger(total) || total === 0) return null;
  const model = agyString(chatModel, 19);
  return {
    atMs: timestamp(agyMessage(agyMessage(chatModel, 9), 4)),
    stepIndex: readAgyVarints(generator, 2)[0] ?? null,
    turnIndex: null,
    model: model && /^[\w.-]{1,100}$/.test(model) ? model : null,
    input, cached, output, thinking, total,
  };
}
// @ts-expect-error augur-inject
decodeAgyGeneration = contract(decodeAgyGeneration, { ...augurContract_9ae21ee4, contractId: 'agy-cost-C-1', mode: 'observe', sample: 1, where: 'src/cost/agy-usage-metadata.ts:23', rule: 'contract-wrap', id: '9ae21ee4' }); /* augur-inject:contract-wrap:9ae21ee4 */

export function decodeAgyStepTime(metadata: Uint8Array | null): number | null {
  return timestamp(agyMessage(readAgyWire(metadata), 1));
}
