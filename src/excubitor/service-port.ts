/**
 * Excubitor が返すサービスの実効ポートを解決する。
 *
 * `GET /api/v1/services/<code>` の **top-level `port` は実行時の観測値**で、 サービスが
 * 動いていても null のことがある (revisor が実例: `state: "running"` なのに
 * `port: null`)。 一方 catalog は宣言された正本を必ず持つ (`catalog_snapshot.port`)。
 *
 * port-source-rule のとおり **ポートは catalog が正本**でハードコードしない。 その上で、
 * 実際に待ち受けている値を優先するため 観測値 → catalog の順で拾う (観測値があるなら
 * それが実際の待ち受け先で、 無いときだけ宣言値へ落ちる)。 catalog を見ないと
 * 「サービスは動いているのにポートが解決できない」で機能が止まる
 * (Test Forum 同期が実際にこれで動かなかった)。
 *
 * spec/feature/pr-queue.md §5-b, spec/feature/revisor-test-forum-sync.md。
 */

export interface ServicePortSource {
  port?: number | null;
  catalog_snapshot?: { port?: number | null } | null;
}

function valid(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** 解決できなければ null。 呼び出し側が理由付きで失敗させる。 */
export function resolveServicePort(service: ServicePortSource | null | undefined): number | null {
  if (!service) return null;
  if (valid(service.port)) return service.port;
  const catalogPort = service.catalog_snapshot?.port;
  return valid(catalogPort) ? catalogPort : null;
}
