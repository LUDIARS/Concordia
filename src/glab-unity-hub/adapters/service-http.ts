/**
 * 兄弟サービス (Breviarium / Praeforma) への loopback HTTP。
 *
 * ポートは Excubitor catalog が正本 (port-source-rule)。 観測値 → catalog の順に解決する
 * 既存の `resolveServicePort` を使う。 応答は上限付きで読み、 失敗は `upstream_unavailable`。
 * Praeforma のローカルモードは書き込みに Origin を要求するので、 自分の loopback origin を付ける。
 *
 * @implements spec/feature/glab-unity-hub.md §5 (GUH-ARCH)
 */

import type { ExcubitorClient } from "../../excubitor/client.js";
import { resolveServicePort } from "../../excubitor/service-port.js";
import { boundedJson } from "../../developer-tools/service-http.js";
import { HubError } from "../domain/protocol.js";

export type ServiceCode = "breviarium" | "praeforma";

export class LoopbackServiceHttp {
  constructor(
    private readonly catalog: Pick<ExcubitorClient, "findService">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async port(service: ServiceCode): Promise<number> {
    const found = await this.catalog.findService(service, 5_000).catch(() => null);
    const port = resolveServicePort(found);
    if (port === null) throw new HubError("upstream_unavailable", `${service} is not registered in the Excubitor catalog`);
    return port;
  }

  async request(service: ServiceCode, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const port = await this.port(service);
    const origin = `http://127.0.0.1:${port}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${origin}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json",
          ...(method === "POST" ? { "content-type": "application/json", origin } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new HubError("upstream_unavailable", `${service} is unreachable`);
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw new HubError("not_found", `${service}: not found`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HubError("upstream_unavailable", `${service} returned HTTP ${response.status}`);
    }
    try {
      return await boundedJson(response);
    } catch {
      throw new HubError("upstream_unavailable", `${service} returned an unreadable response`);
    }
  }
}
