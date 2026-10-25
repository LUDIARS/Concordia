import { resolveServicePort, type ServicePortSource } from "../excubitor/service-port.js";
import { OrbisClientId } from "./request.js";
import { OrbisError } from "./errors.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:1c8a9869 */
import augurContract_2e0fa23c from './endpoint.contract.js'; /* augur-inject:contract-predicate:163cf8fe */

export interface OrbisEndpoint { url: string; instanceId: string }

export function resolveOrbisEndpoint(orbis: ServicePortSource | null, concordia: { instance_id?: unknown } | null): OrbisEndpoint {
  const port = resolveServicePort(orbis);
  const instance = OrbisClientId.safeParse(concordia?.instance_id);
  if (!port || !instance.success) throw new OrbisError("orbis_unavailable");
  return { url: `http://127.0.0.1:${port}/`, instanceId: instance.data };
}
// @ts-expect-error augur-inject
resolveOrbisEndpoint = contract(resolveOrbisEndpoint, { ...augurContract_2e0fa23c, contractId: 'orbis-C-2', mode: 'observe', sample: 1, where: 'src/orbis/endpoint.ts:7', rule: 'contract-wrap', id: '2e0fa23c' }); /* augur-inject:contract-wrap:2e0fa23c */
