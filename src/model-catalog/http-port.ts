/** Consumer adapter: endpoint is supplied by the service catalog resolver. */
import { resolveRoleSnapshot, type ModelCatalogPort, type RoleSnapshot } from "./role-policy.js";
export function createHttpModelCatalogPort(input: {
  resolveEndpoint: () => Promise<string>; fetch?: typeof fetch; now?: () => number;
}): ModelCatalogPort {
  const request = input.fetch ?? fetch;
  return { async resolve(query) {
    const base = await input.resolveEndpoint();
    const url = new URL(`${base.replace(/\/$/, "")}/v1/model-catalog/roles/${encodeURIComponent(query.provider)}/${encodeURIComponent(query.role)}`);
    if (query.context) url.searchParams.set("context", query.context);
    const response = await request(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`model_catalog_http_${response.status}`);
    const snapshot = await response.json() as RoleSnapshot;
    if (snapshot.schemaVersion !== 1 || snapshot.provider !== query.provider || snapshot.role !== query.role
      || typeof snapshot.modelId !== "string" || !snapshot.modelId || typeof snapshot.revision !== "string"
      || !snapshot.revision || !snapshot.capabilities || !Array.isArray(snapshot.capabilities.reasoningEfforts)
      || !Array.isArray(snapshot.capabilities.inputModalities)) throw new Error("model_catalog_response_invalid");
    return resolveRoleSnapshot(snapshot, (input.now ?? Date.now)(), query.context);
  } };
}
