/**
 * Hub のモジュール DB を、 Hub worker 以外のプロセス (Bot の `/glab-unity-token`、
 * backend の GitHub webhook) から開く入口。
 *
 * 開くのは設定が揃っているときだけ (guild id が無ければトークンは発行できない)。
 * 1 プロセス 1 接続を使い回す。
 *
 * @implements spec/feature/glab-unity-hub.md §1 / §4d (GUH-STORE)
 */

import { GlabUnityTokenService } from "../application/token-service.js";
import { pullRequestForSpecDraft } from "../domain/spec-draft.js";
import { loadGlabUnityHubConfig, type GlabUnityHubConfig } from "./hub-config.js";
import { openGlabUnityHubDb, SqliteGlabUnityStore } from "./sqlite-store.js";

let shared: { path: string; store: SqliteGlabUnityStore } | null = null;

export function sharedGlabUnityStore(config: Pick<GlabUnityHubConfig, "dbPath">): SqliteGlabUnityStore {
  if (shared && shared.path === config.dbPath) return shared.store;
  const store = new SqliteGlabUnityStore(openGlabUnityHubDb(config.dbPath));
  shared = { path: config.dbPath, store };
  return store;
}

/** `/glab-unity-token` が使う use case。 GLab の guild id が未設定なら null (コマンドは案内だけ返す)。 */
export function createGlabUnityTokenService(config: GlabUnityHubConfig = loadGlabUnityHubConfig()): GlabUnityTokenService | null {
  if (!config.guildId) return null;
  const store = sharedGlabUnityStore(config);
  return new GlabUnityTokenService({ store, audit: store, clock: { now: () => new Date() }, glabGuildId: config.guildId });
}

/**
 * 署名検証済みの GitHub `pull_request` webhook を受けて、 仕様下書きのジョブを積む
 * (src/api/github.ts の受け口から呼ぶ)。 対象外の repo / action なら何もしない。
 * 積んだら true。 ジョブの処理は Hub worker が行う。
 */
export function enqueueGlabSpecDraft(
  claimedRepo: string,
  payload: unknown,
  loadConfig: () => GlabUnityHubConfig = () => loadGlabUnityHubConfig(),
): boolean {
  const config = loadConfig();
  if (config.specRepos.length === 0) return false;
  const event = pullRequestForSpecDraft(claimedRepo, payload, config.specRepos);
  if (!event) return false;
  return sharedGlabUnityStore(config).enqueueJob(event, new Date().toISOString());
}

/** テスト用: 共有接続を捨てる。 */
export function resetSharedGlabUnityStore(): void {
  shared = null;
}
