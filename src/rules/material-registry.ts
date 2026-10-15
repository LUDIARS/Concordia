/**
 * 巡回チャットの素材元 allowlist (spec/feature/patrol-chat.md §4).
 *
 * rule は sourceId でここを参照するだけで、 URL / SQL / ファイル / credential を書けない。
 * 契約が未確認の素材元は登録しても選択不可 (`contract-unverified`) にし、 mock で対応済みと偽らない。
 */

import { MaterialSourceError, type MaterialSource, type SourceErrorCode } from "./material-types.js";

export interface SourceDescriptor {
  sourceId: string;
  label: string;
  kind: "trend" | "activity";
  serviceCode: string;
  /** 素材が出せる共有範囲 (`*` = 公開)。 */
  scopes: string[];
  /** 選択不可の理由。 null なら接続可能。 */
  unavailable: SourceErrorCode | null;
  source: MaterialSource | null;
}

export interface SourceStatus {
  sourceId: string;
  label: string;
  kind: SourceDescriptor["kind"];
  serviceCode: string;
  scopes: string[];
  status: "ready" | "unavailable";
  reason: string | null;
  lastFetchedAt: string | null;
  lastError: string | null;
}

export class MaterialSourceRegistry {
  private readonly bySourceId = new Map<string, SourceDescriptor>();
  private readonly observations = new Map<string, { at: string; error: string | null }>();

  constructor(descriptors: SourceDescriptor[]) {
    for (const d of descriptors) this.bySourceId.set(d.sourceId, d);
  }

  has(sourceId: string): boolean {
    return this.bySourceId.has(sourceId);
  }

  describe(sourceId: string): SourceDescriptor | null {
    return this.bySourceId.get(sourceId) ?? null;
  }

  /** 接続可能な source を返す。 不可なら理由付きで throw。 */
  resolve(sourceId: string): MaterialSource {
    const d = this.bySourceId.get(sourceId);
    if (!d) throw new MaterialSourceError("unavailable", `unknown source: ${sourceId}`);
    if (d.unavailable || !d.source) {
      throw new MaterialSourceError(d.unavailable ?? "unavailable", `${sourceId}: ${d.unavailable ?? "no adapter"}`);
    }
    return d.source;
  }

  /** 取得結果を記録する (UI の最終取得時刻・最終エラー表示用、 メモリのみ)。 */
  observe(sourceId: string, at: string, error: string | null): void {
    this.observations.set(sourceId, { at, error });
  }

  statuses(): SourceStatus[] {
    return [...this.bySourceId.values()].map((d) => {
      const seen = this.observations.get(d.sourceId);
      return {
        sourceId: d.sourceId,
        label: d.label,
        kind: d.kind,
        serviceCode: d.serviceCode,
        scopes: d.scopes,
        status: d.unavailable || !d.source ? "unavailable" : "ready",
        reason: d.unavailable,
        lastFetchedAt: seen?.at ?? null,
        lastError: seen?.error ?? null,
      };
    });
  }
}
