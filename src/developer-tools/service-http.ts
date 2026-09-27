import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import { unavailable } from "./contracts.js";

export async function boundedJson(response: Response, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) throw new Error("response too large");
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel(); reader.releaseLock(); }
}

/** Only service-owned catalog endpoints are accepted; no caller-supplied URL or credential. */
export class ToolServiceHttp {
  constructor(private readonly catalog: Pick<ExcubitorClient, "findService">,
    private readonly fetchImpl: typeof fetch = fetch) {}

  async request(serviceCode: "praeforma" | "anatomia", path: string, body?: unknown): Promise<unknown> {
    const service = await this.catalog.findService(serviceCode, 5_000);
    const port = service?.catalog_snapshot?.port !== undefined
      ? resolveServicePort({ port: service.catalog_snapshot.port }) : resolveServicePort(service);
    if (!service || port === null) unavailable("service_not_registered", `${serviceCode} の所有 Excubitor catalog を登録してください。`);
    if (!["running", "healthy"].includes(service.state)) unavailable("service_stopped", `${serviceCode} を本体から Excubitor 経由で起動してください。`);
    let response: Response;
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { return unavailable("service_unreachable", `${serviceCode} の接続と準備状態を確認してください。`); }
    if (!response.ok) {
      await response.body?.cancel();
      const reason = [401, 403].includes(response.status) ? "authentication_required"
        : response.status === 404 ? "project_not_registered" : response.status === 409 ? "analysis_not_prepared" : "service_request_failed";
      unavailable(reason, `${serviceCode}: 認証・対象プロジェクト登録・解析準備を確認してください (HTTP ${response.status})。`);
    }
    return boundedJson(response);
  }
}
