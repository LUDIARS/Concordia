// @implements CC-ACTIO-CHAT-COMMAND-01
import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";

/** @implements CC-ACTIO-CHAT-COMMAND-01 */
async function actioBase(catalog: Pick<ExcubitorClient, "findService">): Promise<string> {
  const service = await catalog.findService("actio", 5000);
  const port = resolveServicePort(service?.catalog_snapshot?.port !== undefined ? { port: service.catalog_snapshot.port } : service);
  if (service?.state !== "running" || port === null) throw new Error("Actio unavailable");
  return `http://127.0.0.1:${port}`;
}
/** Read-only live admission. Secret and provider errors never reach Discord. */
class ActioChatAdmission {
  constructor(private readonly catalog: Pick<ExcubitorClient, "findService">, private readonly secret: () => string, private readonly request: typeof fetch) {}
  /** @implements CC-ACTIO-CHAT-COMMAND-01 */
  async check(guildId: string, channelId: string): Promise<boolean> {
    const key = this.secret();
    if (!key) throw new Error("Actio chat credential unavailable");
    const base = await actioBase(this.catalog);
    const response = await this.request(`${base}/api/chat/commands/access`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ guildId, channelId }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Actio admission unavailable"); }
    const data = await response.json() as { allowed?: unknown };
    return data.allowed === true;
  }
}
/** @implements CC-ACTIO-CHAT-COMMAND-01 */
export function createBacklogAdmission(catalog: Pick<ExcubitorClient, "findService">, secret: () => string, request: typeof fetch = fetch): (guildId: string, channelId: string) => Promise<boolean> {
  const client = new ActioChatAdmission(catalog, secret, request);
  return client.check.bind(client);
}
