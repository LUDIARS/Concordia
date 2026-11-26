/**
 * Praeforma の仕様ツール (PraeformaSpecPort の HTTP 実装、 契約 v1 §4d)。
 *
 * Praeforma の現行 API に従う:
 * - 断片: `POST /api/projects/:pid/spec-fragments` `{content, sourceEventId}` (同じ sourceEventId は replay)
 * - 再構築: `POST /api/projects/:pid/spec-versions/reconstructions` → `{proposal:{id, plan:{changes}}}`
 * - 処理結果: `GET /api/projects/:pid/spec-fragments` の `items[].disposition.state`
 * - 未確定の案: `GET /api/projects/:pid/spec-versions/reconstructions`
 * - 採否: `POST /api/projects/:pid/spec-versions/reconstructions/:rid/decide` `{rejectedChanges}`
 * 書き込みはローカルモードの Origin 規則に合わせて loopback origin を付ける (service-http)。
 *
 * @implements spec/feature/glab-unity-hub.md §4d (GUH-SPEC)
 */

import { HubError } from "../domain/protocol.js";
import type { PraeformaSpecPort } from "../application/ports.js";
import type { LoopbackServiceHttp } from "./service-http.js";

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
}

function changeCountOf(proposal: Json | null): number {
  const changes = record(proposal?.plan)?.changes;
  return Array.isArray(changes) ? changes.length : 0;
}

export class PraeformaSpecClient implements PraeformaSpecPort {
  constructor(
    private readonly http: Pick<LoopbackServiceHttp, "request">,
    private readonly webUrl: string | null,
  ) {}

  async createFragment(pid: string, input: { content: string; sourceEventId: string }): Promise<{ fragmentId: string }> {
    const response = record(await this.http.request("praeforma", "POST", `/api/projects/${encodeURIComponent(pid)}/spec-fragments`, input));
    const fragment = record(response?.fragment);
    if (typeof fragment?.id !== "string" || fragment.sourceEventId !== input.sourceEventId) {
      throw new HubError("upstream_unavailable", "Praeforma did not confirm the fragment");
    }
    return { fragmentId: fragment.id };
  }

  async requestReconstruction(pid: string): Promise<{ reconstructionId: string; changeCount: number } | { reconstructionId: null; reason: string }> {
    try {
      const response = record(await this.http.request("praeforma", "POST",
        `/api/projects/${encodeURIComponent(pid)}/spec-versions/reconstructions`, {}, 300_000));
      const proposal = record(response?.proposal);
      if (typeof proposal?.id !== "string") return { reconstructionId: null, reason: "no proposal in response" };
      return { reconstructionId: proposal.id, changeCount: changeCountOf(proposal) };
    } catch (error) {
      // 未定義ドメイン・他の再構築が実行中などは Praeforma 側の事情。 下書き (断片) は残す。
      return { reconstructionId: null, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async fragmentDispositions(pid: string): Promise<Map<string, string>> {
    const response = record(await this.http.request("praeforma", "GET", `/api/projects/${encodeURIComponent(pid)}/spec-fragments?limit=100&offset=0`));
    const result = new Map<string, string>();
    for (const item of Array.isArray(response?.items) ? response.items : []) {
      const row = record(item);
      const state = record(row?.disposition)?.state;
      if (typeof row?.id === "string" && typeof state === "string") result.set(row.id, state);
    }
    return result;
  }

  async pendingReconstruction(pid: string): Promise<{ id: string; changeCount: number } | null> {
    const response = record(await this.http.request("praeforma", "GET", `/api/projects/${encodeURIComponent(pid)}/spec-versions/reconstructions`));
    const proposal = record(response?.proposal) ?? (Array.isArray(response?.items) ? record(response.items[0]) : null);
    if (typeof proposal?.id !== "string") return null;
    return { id: proposal.id, changeCount: changeCountOf(proposal) };
  }

  async decide(pid: string, reconstructionId: string, decision: { rejectedChanges: Array<{ index: number; reason: string }> }): Promise<void> {
    await this.http.request("praeforma", "POST",
      `/api/projects/${encodeURIComponent(pid)}/spec-versions/reconstructions/${encodeURIComponent(reconstructionId)}/decide`, decision);
  }

  linkFor(pid: string): string | null {
    if (!this.webUrl) return null;
    return `${this.webUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(pid)}/specs`;
  }
}
