/**
 * リポ名 → Excubitor のサービスコードの解決。
 *
 * サービスコードはリポ名と一致しない (Memoria → `memoria-server` 等)。 唯一の確かな手掛かりは
 * catalog の `cwd` (= そのサービスを起動するクローンのパス) なので、 **cwd の末尾ディレクトリ名**で
 * 突き合わせる。 Excubitor に問い合わせるので結果は短時間キャッシュする。
 *
 * 起動を伴わないリポ (ライブラリ等) は null を返す — これは異常ではない。
 */

import { basename, normalize } from "node:path";
import type { ExcubitorClient } from "../excubitor/client.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("release/service-map");

const CACHE_TTL_MS = 60_000;

export interface ServiceMapDeps {
  excubitor: ExcubitorClient;
  now?: () => number;
}

export class ServiceMap {
  private cache: Map<string, string> | null = null;
  private cachedAt = 0;

  constructor(private readonly deps: ServiceMapDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** リポ名 (ローカルクローンのディレクトリ名) に対応するサービスコード。 無ければ null。 */
  async resolve(repoName: string): Promise<string | null> {
    const map = await this.load();
    return map.get(repoName.toLowerCase()) ?? null;
  }

  private async load(): Promise<Map<string, string>> {
    if (this.cache && this.now - this.cachedAt < CACHE_TTL_MS) return this.cache;
    const map = new Map<string, string>();
    try {
      for (const svc of await this.deps.excubitor.listServices()) {
        // develop 版のエントリは main 側の写しなので突き合わせに使わない。
        if (svc.code.endsWith("-develop")) continue;
        const cwd = svc.catalog_snapshot?.cwd;
        if (!cwd) continue;
        const name = basename(normalize(cwd)).toLowerCase();
        if (!map.has(name)) map.set(name, svc.code);
      }
      this.cache = map;
      this.cachedAt = this.now;
    } catch (e) {
      // Excubitor が落ちていても確認待ちは積みたい (service_code は後から埋め直せる)。
      log.warn({ err: (e as Error).message }, "Excubitor のサービス一覧を取得できなかった");
      return this.cache ?? map;
    }
    return map;
  }
}
