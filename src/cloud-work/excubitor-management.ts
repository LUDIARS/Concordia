import { excubitorBaseUrl } from "../config/service-urls.js";
import { resolveServicePort } from "../excubitor/service-port.js";

type ReadJson = (response: Response) => Promise<unknown>;

/** Resolve the management listener by its exact service entry and verify the listener identity. */
export async function resolveExcubitorManagement(env: NodeJS.ProcessEnv, fetcher: typeof fetch, readJson: ReadJson): Promise<URL> {
  const discovery = new URL(excubitorBaseUrl(env));
  if (discovery.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(discovery.hostname)
    || discovery.username || discovery.password || discovery.pathname !== "/" || discovery.search || discovery.hash) {
    throw new Error("excubitor_management_unavailable");
  }
  const get = async (path: string, base: URL) => {
    const response = await fetcher(new URL(path, base), { redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("excubitor_management_unavailable");
    }
    return readJson(response);
  };
  const service = await get("/api/v1/services/excubitor", discovery) as Parameters<typeof resolveServicePort>[0] & { code?: string };
  const port = service?.code === "excubitor" ? resolveServicePort(service) : null;
  if (!port) throw new Error("excubitor_management_unavailable");
  const endpoint = new URL(discovery);
  endpoint.port = String(port);
  const health = await get("/health", endpoint) as { service?: string } | null;
  if (health?.service !== "excubitor") throw new Error("excubitor_management_unavailable");
  return endpoint;
}
