/**
 * 「許可要求を Discord へ投稿するか」 の設定を、 都度解決する関数に正規化する。
 *
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W6
 *
 * 起動時に解決した `DiscordEnv` スナップショットを握ると、 Web UI で
 * `conn_permission_requests_enabled` を変えても Concordia を再起動するまで効かない。
 * Revisor token の `toTokenResolver` (src/pr/revisor-token.ts) が既に解いている同型の
 * 問題なので、 同じ形 (値ではなく resolver を持つ) に寄せる。
 */

import type { DiscordEnv } from "./types.js";

type PermissionRequestConfig = Pick<DiscordEnv, "permissionRequestsEnabled">;

/** 解決済み設定 1 点に対する判定 (純関数)。 */
export function shouldPostPermissionRequestToDiscord(config: PermissionRequestConfig): boolean {
  return config.permissionRequestsEnabled;
}

/** 設定そのもの / 設定を返す関数 のどちらを渡されても「都度解決する関数」に揃える。 */
export function toPermissionRequestsResolver(
  source: PermissionRequestConfig | (() => PermissionRequestConfig),
): () => boolean {
  if (typeof source === "function") return () => shouldPostPermissionRequestToDiscord(source());
  return () => shouldPostPermissionRequestToDiscord(source);
}
