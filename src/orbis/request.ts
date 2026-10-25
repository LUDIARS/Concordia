import { z } from "zod";
import { OrbisError } from "./errors.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:2f917def */
import augurContract_48a2d41c from './request.contract.js'; /* augur-inject:contract-predicate:491eb4e7 */

export const ORBIS_OPERATIONS = ["attach", "detach", "open", "navigate", "read", "act", "logs", "reveal"] as const;
export type OrbisOperation = typeof ORBIS_OPERATIONS[number];
export const OrbisClientId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const Sigillum = z.string().trim().min(1).max(4096);
const Url = z.string().max(8192).url().refine(value => ["http:", "https:"].includes(new URL(value).protocol));
const base = { sigillum: Sigillum };
export const OrbisAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number().finite(), y: z.number().finite() }).strict(),
  z.object({ type: z.literal("type"), text: z.string().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("scroll"), deltaY: z.number().finite().optional() }).strict(),
  z.object({ type: z.literal("select"), selector: z.string().min(1).max(2000), value: z.string().max(2000) }).strict(),
]);
/** Shared by HTTP, MCP and the use case, so no entry point can broaden the vocabulary. */
export const OrbisInputs = {
  attach: z.object(base).strict(),
  detach: z.object(base).strict(),
  open: z.object({ ...base, url: Url, visible: z.boolean().default(false) }).strict(),
  navigate: z.object({ ...base, url: Url }).strict(),
  read: z.object({ ...base, mode: z.enum(["text", "dom", "a11y", "screenshot"]).default("text") }).strict(),
  act: z.object({ ...base, action: OrbisAction }).strict(),
  logs: z.object({ ...base, since: z.string().max(256).optional() }).strict(),
  reveal: z.object({ ...base, userUtteranceId: z.string().min(1).max(256) }).strict(),
};
export type OrbisRequest = { [K in OrbisOperation]: { operation: K } & z.infer<typeof OrbisInputs[K]> }[OrbisOperation];

export function parseOrbisRequest(operation: OrbisOperation, input: unknown): OrbisRequest {
  if (!ORBIS_OPERATIONS.includes(operation)) throw new OrbisError("orbis_invalid_request");
  const result = OrbisInputs[operation].safeParse(input);
  if (!result.success) throw new OrbisError("orbis_invalid_request");
  return { operation, ...result.data } as OrbisRequest;
}
// @ts-expect-error augur-inject
parseOrbisRequest = contract(parseOrbisRequest, { ...augurContract_48a2d41c, contractId: 'orbis-C-1', mode: 'observe', sample: 1, where: 'src/orbis/request.ts:29', rule: 'contract-wrap', id: '48a2d41c' }); /* augur-inject:contract-wrap:48a2d41c */
