/**
 * 連合ロールの組み立て (bootstrap から切り出した配線層)。
 *
 * bootstrap/core.ts は「いつ起動するか」だけを持ち、どの repo / listener /
 * クライアントをどう繋ぐかはここに閉じる (startBackend をこれ以上太らせない)。
 *
 * - 登録簿 / outbox / ライブ接続レジストリと管理 API 依存は常に作る
 *   (listener 有効化前に拠点登録 = トークン発行ができるように)。
 * - listener (本社ロール) と拠点クライアント (拠点ロール) は DB → env で opt-in。
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
import type { SettingsStore } from "../admin/settings-store.js";
import {
  listenerNeedsRestart,
  resolveFederationListener,
  resolveFederationSite,
  siteClientNeedsRestart,
  updateFederationListener,
  updateFederationSite,
  type FederationListenerConfig,
} from "./listener-settings.js";
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
  /**
   * 設定 (DB → env) で有効化されたロール (listener / 拠点クライアント) を起動し、
   * 以後は両ロールの設定変更へ追随する (再起動不要)。
   */
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
  /** listener 設定の正本 (DB)。 未注入なら env のみで解決する。 */
  settings?: SettingsStore;
  /** 設定変更を拾う間隔 (ms)。 既定 10 秒。 */
  settingsPollMs?: number;
}

export function createFederationRuntime(opts: FederationRuntimeOptions): FederationRuntime {
  const env = opts.env ?? readFederationEnv(process.env, {
    // listener の port は DB が補えるため、複合検証は解決後に行う。
    deferListenerPortValidation: Boolean(opts.settings),
  });
  const sites = makeFederationSitesRepo(opts.db, opts.secretBox);
  const outbox = makeFederationOutboxRepo(opts.db, {
    maxRows: env.outboxMaxRows,
    ttlSec: env.outboxTtlSec,
  });
  const connections = createFederationConnections();
  let listener: FederationListenerHandle | null = null;
  /** 実際に待ち受けている bind 先 (未起動なら null)。 設定との差分判定に使う。 */
  let listenerBinding: { host: string; port: number } | null = null;
  let listenerPoll: ReturnType<typeof setInterval> | null = null;
  let listenerSync = Promise.resolve();
  let stopped = false;
  /** 実際に繋ぎに行っている拠点ロールの束縛 (未接続なら null)。 */
  let siteBinding: { hqUrl: string; siteId: string; token: string } | null = null;
  const currentSiteConfig = () =>
    opts.settings
      ? resolveFederationSite(opts.settings, env, opts.secretBox)
      : {
          hqUrl: env.hqUrl,
          siteId: env.siteId,
          token: env.siteToken,
          tokenDecryptionFailed: false,
          hasToken: Boolean(env.siteToken),
          source: { hqUrl: "env" as const, siteId: "env" as const, token: "env" as const },
        };
  const currentListenerConfig = (): FederationListenerConfig =>
    opts.settings
      ? resolveFederationListener(opts.settings, env)
      : {
          enabled: env.listenEnabled,
          port: env.listenPort,
          host: env.listenHost,
          source: { enabled: "env", port: "env", host: "env" },
        };
  const initialListenerConfig = currentListenerConfig();
  if (initialListenerConfig.enabled && initialListenerConfig.port === null) {
    throw new Error("resolved federation listener settings require a port when enabled");
  }
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

  async function startListener(host: string, port: number): Promise<void> {
    try {
      const started = await startFederationListener({
        host,
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
      if (stopped) {
        started.close();
        return;
      }
      listener = started;
      listenerBinding = { host, port };
      log.info(`federation listener started on ${host}:${port}`);
    } catch (e) {
      listener = null;
      listenerBinding = null;
      log.error({ err: (e as Error).message }, "federation listener failed to start");
      reportError("federation", `連合 listener の起動に失敗しました (${host}:${port}): ${(e as Error).message}`);
    }
  }

  function stopListener(): void {
    if (!listener) return;
    try {
      listener.close();
    } catch (e) {
      log.warn(`federation listener close failed: ${(e as Error).message}`);
    }
    listener = null;
    listenerBinding = null;
    log.info("federation listener stopped");
  }

  /**
   * 設定 (DB → env) と実際の待ち受け状態を突き合わせて張り替える。
   *
   * 設定変更を再起動なしで効かせるための唯一の経路。 起動失敗時は listenerBinding を
   * 立てないので、 次のティックで同じ設定のまま再試行される (ポートが空くまで待てる)。
   */
  async function applyListenerConfig(): Promise<void> {
    if (stopped) return;
    const desired = currentListenerConfig();
    switch (listenerNeedsRestart(listenerBinding, desired)) {
      case "start":
        await startListener(desired.host, desired.port!);
        return;
      case "stop":
        stopListener();
        return;
      case "restart":
        stopListener();
        await startListener(desired.host, desired.port!);
        return;
      default:
        return;
    }
  }

  /** API 更新と poll が重なっても bind/close を直列化し、二重 listener を作らない。 */
  function syncListener(): Promise<void> {
    listenerSync = listenerSync.then(applyListenerConfig, applyListenerConfig);
    return listenerSync;
  }

  function startSiteClient(binding: { hqUrl: string; siteId: string; token: string }): void {
    try {
      siteClient = startFederationSiteClient({
        hqUrl: binding.hqUrl,
        siteId: binding.siteId,
        token: binding.token,
        siteVersion: opts.version,
      });
      siteBinding = binding;
      // query/path に資格情報相当が含まれていてもログへ出さない。
      log.info(`federation site client started site=${binding.siteId} hq_origin=${new URL(binding.hqUrl).origin}`);
    } catch (e) {
      siteBinding = null;
      log.error({ err: (e as Error).message }, "federation site client failed to start");
      reportError("federation", `連合クライアントの起動に失敗しました: ${(e as Error).message}`);
    }
  }

  function stopSiteClient(): void {
    if (!siteClient) return;
    siteClient.stop();
    siteClient = null;
    siteBinding = null;
    log.info("federation site client stopped");
  }

  /** 拠点ロールの設定と実接続を突き合わせて張り替える (listener と同じ扱い)。 */
  function syncSiteClient(): void {
    if (stopped) return;
    const desired = currentSiteConfig();
    if (desired.tokenDecryptionFailed) {
      warnSiteTokenDecryptionFailureOnce();
    } else {
      siteTokenDecryptionFailureWarned = false;
    }
    const incomplete = Boolean(desired.hqUrl || desired.siteId || desired.token)
      && !(desired.hqUrl && desired.siteId && desired.token);
    if (incomplete) warnIncompleteSiteConfigOnce(desired);
    else incompleteSiteWarned = "";
    switch (siteClientNeedsRestart(siteBinding, desired)) {
      case "start":
        startSiteClient({ hqUrl: desired.hqUrl!, siteId: desired.siteId!, token: desired.token! });
        return;
      case "stop":
        stopSiteClient();
        return;
      case "restart":
        stopSiteClient();
        startSiteClient({ hqUrl: desired.hqUrl!, siteId: desired.siteId!, token: desired.token! });
        return;
      default:
        return;
    }
  }

  let incompleteSiteWarned = "";
  let siteTokenDecryptionFailureWarned = false;
  function warnSiteTokenDecryptionFailureOnce(): void {
    if (siteTokenDecryptionFailureWarned) return;
    siteTokenDecryptionFailureWarned = true;
    log.warn("stored federation site token cannot be decrypted; using the configured env fallback if present");
    reportError("federation", "保存済みの連合拠点トークンを復号できません。暗号鍵またはトークン設定を確認してください");
  }

  function warnIncompleteSiteConfigOnce(desired: { hqUrl: string | null; siteId: string | null; token: string | null }): void {
    const missing = [
      desired.hqUrl ? null : "hq_url",
      desired.siteId ? null : "site_id",
      desired.token ? null : "token",
    ].filter((value): value is string => value !== null).join(", ");
    if (incompleteSiteWarned === missing) return;
    incompleteSiteWarned = missing;
    log.warn(`federation site client disabled; missing ${missing}`);
  }

  return {
    apiDeps: {
      sites,
      outbox,
      connections,
      listenerEnabled: currentListenerConfig().enabled,
      disconnectSite: (siteId, code) => listener?.disconnect(siteId, code),
      redistributeConfig: (siteId) => listener?.sendConfigUpdate(siteId) ?? false,
      listenerStatus: () => ({ config: currentListenerConfig(), running: listenerBinding }),
      siteStatus: () => {
        const { token: _token, tokenDecryptionFailed: _tokenError, ...config } = currentSiteConfig();
        return {
          config,
          running: siteBinding ? { hqUrl: siteBinding.hqUrl, siteId: siteBinding.siteId } : null,
        };
      },
      updateSite: async (patch) => {
        if (!opts.settings) return { ok: false, error: "site settings store is not configured" };
        const result = updateFederationSite(opts.settings, opts.secretBox, patch);
        if (!result.ok) return result;
        syncSiteClient();
        const { token: _token, tokenDecryptionFailed: _tokenError, ...config } = currentSiteConfig();
        return {
          ok: true,
          config,
          running: siteBinding ? { hqUrl: siteBinding.hqUrl, siteId: siteBinding.siteId } : null,
        };
      },
      updateListener: async (patch) => {
        if (!opts.settings) return { ok: false, error: "listener settings store is not configured" };
        const result = updateFederationListener(opts.settings, env, patch);
        if (!result.ok) return result;
        // 待たせてでもここで張り替える — 応答が返った時点の状態を返せるようにする。
        await syncListener();
        return { ok: true, config: currentListenerConfig(), running: listenerBinding };
      },
    },
    async startRoles() {
      if (stopped) return;
      // Villa が落ちていても起動を待たせない (拠点タグ無しで degrade する)。
      void refreshVillaPcs();
      await syncListener();
      syncSiteClient();
      // 設定変更 (WebUI / API) を再起動なしで拾う。 env のみ構成でも害は無い (差分ゼロ)。
      if (opts.settings && listenerPoll === null) {
        listenerPoll = setInterval(() => {
          void syncListener().catch((error) => {
            log.error({ err: (error as Error).message }, "federation listener settings sync failed");
          });
          try {
            syncSiteClient();
          } catch (error) {
            log.error({ err: (error as Error).message }, "federation site settings sync failed");
          }
        }, opts.settingsPollMs ?? 10_000);
        listenerPoll.unref?.();
      }
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
      stopped = true;
      if (listenerPoll) { clearInterval(listenerPoll); listenerPoll = null; }
      stopSiteClient();
      stopListener();
    },
  };
}
