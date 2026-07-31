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
import { authorizeEgressRequest, resolveDepartmentRoute } from "./department-routing.js";
import { resolveSiteFromForumTags } from "./forum-site-routing.js";
import { VillaClient, type VillaPc } from "../villa/client.js";
import type { FederationEgressRequestFrame } from "./protocol.js";

export interface FederationIngressInput {
  guild_id: string;
  channel_id: string;
  message_id: string;
  author_id: string;
  author_label: string;
  text: string;
  ts: number;
  applied_tag_names?: readonly string[];
}

const log = createChildLogger("federation/runtime");

/** Villa の PC 構成はほぼ変わらないので、短い TTL で十分 (反映は次ティック)。 */
const VILLA_CACHE_TTL_MS = 60_000;

/**
 * 同じチャンネルの同じ拠点タグ警告を再報告するまでの間隔。
 *
 * 拠点タグの判定は 1 メッセージごとに走るので、素通しすると失効タグの付いた
 * スレッドで発言するたび errors チャンネルへ同じ警告が積まれる。
 */
const INGRESS_WARNING_TTL_MS = 10 * 60 * 1000;
const ingressWarningReportedAt = new Map<string, number>();

function reportIngressWarningOnce(channelId: string, warning: string): void {
  const key = `${channelId}\t${warning}`;
  const now = Date.now();
  const last = ingressWarningReportedAt.get(key);
  if (last !== undefined && now - last < INGRESS_WARNING_TTL_MS) return;
  ingressWarningReportedAt.set(key, now);
  for (const [storedKey, ts] of ingressWarningReportedAt) {
    if (now - ts >= INGRESS_WARNING_TTL_MS) ingressWarningReportedAt.delete(storedKey);
  }
  reportError("federation", warning);
}

export interface FederationRuntime {
  /** registerCoreRoutes に渡す /v1/federation の依存 (常に供給)。 */
  apiDeps: FederationApiDeps;
  /** env で有効化されたロール (listener / 拠点クライアント) を起動する。 */
  startRoles(): Promise<void>;
  /** Discord ingress が担当拠点へ渡せた場合だけ true。 */
  routeIngress(input: FederationIngressInput): boolean;
  /** Discord のタグ同期用。Villa 停止時は空配列で既存タグだけを維持する。 */
  listForumSiteTagNames(): Promise<string[]>;
  /** Discord 実体を bootstrap から渡す egress ポート。 */
  setEgressExecutor(executor: ((request: FederationEgressRequestFrame) => Promise<{ ok: boolean; error?: string }>) | null): void;
  stop(): void;
}

export interface FederationRuntimeOptions {
  db: Database.Database;
  secretBox: SecretBox;
  /** hello / welcome で名乗るバージョン。 */
  version: string;
  /** 既定は process.env からの読み込み (設定不備は throw = fail-fast)。 */
  env?: FederationEnv;
  villaClient?: VillaClient;
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
  let egressExecutor: ((request: FederationEgressRequestFrame) => Promise<{ ok: boolean; error?: string }>) | null = null;
  const villa = opts.villaClient ?? new VillaClient();
  let villaPcs: VillaPc[] = [];
  let villaFetchedAt = 0;
  let villaInflight: Promise<VillaPc[]> | null = null;

  /**
   * PC 一覧は Discord のレイアウト同期 (monitor / pr-queue の定期更新) から
   * 毎ティック呼ばれる。Villa が落ちていると 1 回あたりタイムアウト分待たされるので、
   * TTL と in-flight 共有で「1 ティックにつき最大 1 リクエスト」に抑える。
   */
  async function refreshVillaPcs(): Promise<VillaPc[]> {
    if (Date.now() - villaFetchedAt < VILLA_CACHE_TTL_MS) return villaPcs;
    if (villaInflight) return villaInflight;
    villaInflight = (async () => {
      try {
        const state = await villa.getState();
        villaPcs = state?.pcs ?? [];
        if (!state) log.warn("Villa state is unavailable; forum site tags are disabled");
      } catch (error) {
        villaPcs = [];
        log.warn(`Villa state fetch failed; forum site tags are disabled: ${(error as Error).message}`);
      }
      villaFetchedAt = Date.now();
      return villaPcs;
    })().finally(() => { villaInflight = null; });
    return villaInflight;
  }

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
        handleEgressRequest: async (siteId, request) => {
          const authorized = authorizeEgressRequest(sites, siteId, request);
          if (!authorized.ok) {
            log.warn(`federation egress denied site=${siteId} guild=${request.guild_id}`);
            return authorized;
          }
          if (!egressExecutor) return { ok: false, error: "HQ Discord egress is unavailable" };
          return egressExecutor(request);
        },
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
      // Villa が落ちていても起動を待たせない (拠点タグ無しで degrade する)。
      void refreshVillaPcs();
      if (env.listenEnabled && env.listenPort !== null) await startListener(env.listenPort);
      if (env.hqUrl) startSiteClient(env.hqUrl);
    },
    routeIngress(input) {
      const appliedTagNames = input.applied_tag_names ?? [];
      let forumRoute: ReturnType<typeof resolveSiteFromForumTags> = { route: null, warnings: [] };
      if (appliedTagNames.length > 0) {
        // 判定は同期に返す必要があるのでキャッシュだけを見る。次メッセージ以降のために
        // TTL 切れなら裏で取り直す (レイアウト同期が無効な構成でも PC 追加へ追随する)。
        void refreshVillaPcs();
        forumRoute = resolveSiteFromForumTags(sites.list(), villaPcs, appliedTagNames);
      }
      for (const warning of forumRoute.warnings) {
        log.warn(warning);
        reportIngressWarningOnce(input.channel_id, warning);
      }
      const route = forumRoute.route ?? resolveDepartmentRoute(sites, input.guild_id);
      if (route.kind !== "site" || !listener) return false;
      listener.enqueue(route.siteId, { type: "ingress", ...input });
      return true;
    },
    async listForumSiteTagNames() {
      const pcs = await refreshVillaPcs();
      const activePcIds = new Set(sites.list()
        .filter((site) => site.status === "active" && site.villa_pc_id)
        .map((site) => site.villa_pc_id));
      return pcs.filter((pc) => activePcIds.has(pc.id)).map((pc) => pc.name);
    },
    setEgressExecutor(executor) {
      egressExecutor = executor;
    },
    stop() {
      siteClient?.stop();
      siteClient = null;
      listener?.close();
      listener = null;
    },
  };
}
