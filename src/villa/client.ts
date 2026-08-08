/**
 * Villa (PC 台帳サービス) の読み取りクライアント。
 *
 * 連合拠点タグの PC 名は Concordia に固定せず Villa を正本にする
 * (spec/feature/federation-link.md 「拠点タグによる実行先指定」)。
 */

import { villaBaseUrl } from "../config/service-urls.js";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface VillaPc { id: string; name: string; location?: string; role?: string; mode?: string; }
export interface VillaState { pcs: VillaPc[]; }

/**
 * Villa の PC 一覧だけを読む最小クライアント。
 *
 * Villa は Concordia の必須依存ではないので、呼び出し側が「拠点タグ無し」へ退避できる形で
 * 返す: 応答が想定形でなければ null、停止・タイムアウト・HTTP エラーは throw (runtime 側で
 * catch して空候補にする)。
 */
export class VillaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.baseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, "") : villaBaseUrl();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }
  async getState(): Promise<VillaState | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/state`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Villa state request failed: ${response.status}`);
      const payload = await response.json() as { state?: unknown };
      const state = payload.state;
      if (!state || typeof state !== "object") return null;
      const pcs = (state as { pcs?: unknown }).pcs;
      if (!Array.isArray(pcs)) return null;
      return { pcs: pcs.filter(isVillaPc) };
    } finally { clearTimeout(timer); }
  }
}

function isVillaPc(value: unknown): value is VillaPc {
  return !!value && typeof value === "object" && typeof (value as VillaPc).id === "string" && typeof (value as VillaPc).name === "string";
}
