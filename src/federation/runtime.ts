/**
 * 連合ロールの組み立て (bootstrap から切り出した配線層)。
 *
 * bootstrap/core.ts は「いつ起動するか」だけを持ち、どの repo / listener /
 * クライアントをどう繋ぐかはここに閉じる (startBackend をこれ以上太らせない)。
 *
 * - 登録簿 / outbox / ライブ接続レジストリと管理 API 依存は常に作る
 *   (listener 有効化前に拠点登録 = トークン発行ができるように)。
 * - listener (本社ロール) と拠点クライアント (拠点ロール) は env で opt-in。
 *   起動失敗は reportError で報告して本体を巻き込まない (連合面だけ無効のまま続行)。
 */

import type Database from "better-sqlite3";
import type { FederationApiDeps } from "../api/federation.js";
import { makeFederationOutboxRepo } from "../db/federation-outbox-repo.js";
import { makeFederationSitesRepo } from "../db/federation-sites-repo.js";
import { reportError } from "../errors.js";
import { createChildLogger } from "../shared/logger.js";
import type { SecretBox } from "../shared/secret-box.js";
import { readFederationEnv, type FederationEnv } from "./env.js";
import { createFederationConnections } from "./hq-connections.js";
import { createFederationConfigSnapshot } from "./config-snapshot.js";
import { startFederationListener, type FederationListenerHandle } from "./hq-listener.js";
import { startFederationSiteClient, type FederationSiteClientHandle } from "./site-client.js";

const log = createChildLogger("federation/runtime");

export interface FederationRuntime {
  /** registerCoreRoutes に渡す /v1/federation の依存 (常に供給)。 */
  apiDeps: FederationApiDeps;
  /** env で有効化されたロール (listener / 拠点クライアント) を起動する。 */
  startRoles(): Promise<void>;
  stop(): void;
}

export interface FederationRuntimeOptions {
  db: Database.Database;
  secretBox: SecretBox;
  /** hello / welcome で名乗るバージョン。 */
  version: string;
  /** 既定は process.env からの読み込み (設定不備は throw = fail-fast)。 */
  env?: FederationEnv;
}

export function createFederationRuntime(opts: FederationRuntimeOptions): FederationRuntime {
  const env = opts.env ?? readFederationEnv(process.env);
  const sites = makeFederationSitesRepo(opts.db, opts.secretBox);
  const outbox = makeFederationOutboxRepo(opts.db, {
    maxRows: env.outboxMaxRows,
    ttlSec: env.outboxTtlSec,
  });
  const connections = createFederationConnections();
  let listener: FederationListenerHandle | null = null;
  let siteClient: FederationSiteClientHandle | null = null;

  async function startListener(port: number): Promise<void> {
    try {
      listener = await startFederationListener({
        host: env.listenHost,
        port,
        sites,
        outbox,
        connections,
        hqVersion: opts.version,
        createConfigSnapshot: (siteId) => createFederationConfigSnapshot(
          opts.db,
          sites.find(siteId)?.departments ?? [],
        ),
      });
    } catch (e) {
      log.error({ err: (e as Error).message }, "federation listener failed to start");
      reportError("federation", `連合 listener の起動に失敗しました: ${(e as Error).message}`);
    }
  }

  function startSiteClient(hqUrl: string): void {
    if (!env.siteId || !env.siteToken) {
      log.warn("CONCORDIA_FEDERATION_HQ_URL is set but SITE_ID / SITE_TOKEN is missing; federation site client disabled");
      return;
    }
    try {
      siteClient = startFederationSiteClient({
        hqUrl,
        siteId: env.siteId,
        token: env.siteToken,
        siteVersion: opts.version,
      });
    } catch (e) {
      log.error({ err: (e as Error).message }, "federation site client failed to start");
      reportError("federation", `連合クライアントの起動に失敗しました: ${(e as Error).message}`);
    }
  }

  return {
    apiDeps: {
      sites,
      outbox,
      connections,
      listenerEnabled: env.listenEnabled,
      disconnectSite: (siteId, code) => listener?.disconnect(siteId, code),
      redistributeConfig: (siteId) => listener?.sendConfigUpdate(siteId) ?? false,
    },
    async startRoles() {
      if (env.listenEnabled && env.listenPort !== null) await startListener(env.listenPort);
      if (env.hqUrl) startSiteClient(env.hqUrl);
    },
    stop() {
      siteClient?.stop();
      siteClient = null;
      listener?.close();
      listener = null;
    },
  };
}
