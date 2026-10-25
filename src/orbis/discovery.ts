import { ExcubitorClient } from "../excubitor/client.js";
import { resolveOrbisEndpoint, type OrbisEndpoint } from "./endpoint.js";
import { OrbisError } from "./errors.js";

/** Only Excubitor owns endpoint / instance identity. No local port or instance fallback. */
export async function discoverOrbisEndpoint(client: Pick<ExcubitorClient, "findService"> = new ExcubitorClient()): Promise<OrbisEndpoint> {
  try {
    const [orbis, concordia] = await Promise.all([client.findService("orbis", 3000), client.findService("concordia", 3000)]);
    // The common client intentionally models only shared fields. Preserve the service-detail extension.
    return resolveOrbisEndpoint(orbis, concordia as (typeof concordia & { instance_id?: unknown }));
  } catch {
    throw new OrbisError("orbis_unavailable");
  }
}
