/**
 * 本社側の拠点接続レジストリ (in-memory)。
 *
 * WS 接続の生死・最終応答・拠点バージョンを保持し、WebUI の子会社一覧
 * (GET /v1/federation) に接続状態を供給する。永続情報 (登録・最終接続時刻) は
 * federation_sites テーブル側が正本で、ここはプロセス生存中のライブ状態のみ。
 */

export interface FederationLiveConnection {
  siteId: string;
  connectedAtSec: number;
  lastSeenSec: number;
  siteVersion: string | null;
  remoteAddress: string | null;
}

export interface FederationConnections {
  attach(conn: FederationLiveConnection): void;
  detach(siteId: string): void;
  touch(siteId: string, nowSec: number): void;
  get(siteId: string): FederationLiveConnection | null;
}

export function createFederationConnections(): FederationConnections {
  const live = new Map<string, FederationLiveConnection>();
  return {
    attach(conn) {
      live.set(conn.siteId, conn);
    },
    detach(siteId) {
      live.delete(siteId);
    },
    touch(siteId, nowSec) {
      const conn = live.get(siteId);
      if (conn) conn.lastSeenSec = nowSec;
    },
    get(siteId) {
      return live.get(siteId) ?? null;
    },
  };
}
