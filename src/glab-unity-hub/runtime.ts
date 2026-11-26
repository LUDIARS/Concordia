/**
 * GLab-UnityHub の組み立て (composition root から呼ぶ。 module-manifest §3)。
 *
 * 部品を作ってつなぎ、 待受と常駐ループ (失効の見張り・仕様下書きジョブ) を回す。
 * - 失効・期限切れは 2 秒ごとに DB を見て、 該当トークンの接続を 4401 で切る (失効即切断)。
 * - GLab から抜けた人の接続は Discord のイベントで 4403。
 * - 仕様下書きジョブは 30 秒ごとに積まれた分を順に処理する。
 *
 * @implements spec/feature/glab-unity-hub.md §5 (GUH-ARCH)
 */

import { HubAuthenticator } from "./application/authenticate.js";
import { GeoGuard } from "./application/geo-guard.js";
import { ConnectionRegistry } from "./application/connection-registry.js";
import { HubSession } from "./application/hub-session.js";
import { HubDiscordService } from "./application/discord-service.js";
import { HubSprintService } from "./application/sprint-service.js";
import { HubCalliopeService } from "./application/calliope-service.js";
import { HubSpecDraftService } from "./application/spec-draft-service.js";
import { HubMelpomeneService } from "./application/melpomene-service.js";
import { MelpomeneHttpEndpoint } from "./application/melpomene-http.js";
import { createMethodHandlers } from "./application/method-router.js";
import type {
  ActioSprintPort,
  BreviariumPort,
  CalliopeMaterialsPort,
  CalliopeWriterPort,
  Clock,
  DiscordGateway,
  IssuePort,
  NotionBoardPort,
  OverseasNotifier,
  PraeformaSpecPort,
} from "./application/ports.js";
import type { GlabUnityHubConfig } from "./adapters/hub-config.js";
import type { SqliteGlabUnityStore } from "./adapters/sqlite-store.js";
import { PortusHubServer } from "./adapters/portus-server.js";
import type { PortusModules } from "./adapters/portus-loader.js";

export const REVOCATION_POLL_MS = 2_000;
export const SPEC_JOB_POLL_MS = 30_000;
/** RFC 6455 の Going Away (停止時の切断)。 */
const GOING_AWAY = 1001;

export interface GlabUnityHubRuntimeDeps {
  readonly config: GlabUnityHubConfig & { readonly guildId: string; readonly port: number };
  readonly store: SqliteGlabUnityStore;
  readonly discord: DiscordGateway & OverseasNotifier;
  readonly portus: PortusModules;
  readonly breviarium: BreviariumPort;
  readonly notion: NotionBoardPort;
  readonly actio: ActioSprintPort;
  readonly praeforma: PraeformaSpecPort;
  readonly github: IssuePort;
  readonly calliopeMaterials: CalliopeMaterialsPort;
  readonly calliopeWriter: CalliopeWriterPort;
  readonly clock?: Clock;
  readonly log: (message: string) => void;
}

export interface GlabUnityHubRuntime {
  start(): Promise<number>;
  stop(): Promise<void>;
  readonly registry: ConnectionRegistry;
}

export function createGlabUnityHubRuntime(deps: GlabUnityHubRuntimeDeps): GlabUnityHubRuntime {
  const clock = deps.clock ?? { now: () => new Date() };
  const { config, store } = deps;
  const registry = new ConnectionRegistry();
  const authenticator = new HubAuthenticator({ store, discord: deps.discord, clock });
  const geo = new GeoGuard({
    allowedCountries: config.allowedCountries, policy: config.geoPolicy, audit: store, notifier: deps.discord, clock, log: deps.log,
  });
  const discordService = new HubDiscordService(deps.discord);
  const projects = config.projects.map((project) => project.code);
  const melpomene = new HubMelpomeneService({ github: deps.github, discord: deps.discord, audit: store, allowedRepos: config.melpomeneRepos });
  const spec = new HubSpecDraftService({
    store, praeforma: deps.praeforma, github: deps.github, audit: store, clock, specRepos: config.specRepos, log: deps.log,
  });
  const handlers = createMethodHandlers({
    discord: discordService,
    sprint: new HubSprintService({ actio: deps.actio, projects, actioUserOf: (id) => config.actioUsers[id] ?? null, audit: store }),
    calliope: new HubCalliopeService({
      store, materials: deps.calliopeMaterials, writer: deps.calliopeWriter, clock, projects,
      broadcast: (event, data) => registry.broadcast(event, data), log: deps.log,
    }),
    spec,
    melpomene,
    breviarium: deps.breviarium,
    notion: deps.notion,
    guildId: config.guildId,
    notionBoards: config.notionBoards.map((board) => ({ id: board.id, name: board.name })),
    breviariumProjects: config.projects.map((project) => project.breviariumProject),
  });
  const http = new MelpomeneHttpEndpoint({ authenticator, geo, registry, melpomene, audit: store, clock });
  const server = new PortusHubServer({
    portus: deps.portus,
    health: () => ({ ok: true, service: "concordia-glab-unity-hub", connections: registry.size(), geoPolicy: config.geoPolicy }),
    openConnection: ({ socket, origin, authorization }) => new HubSession({
      socket, origin, authorization, authenticator, geo, registry, handlers, audit: store, clock,
    }),
    melpomene: (input) => http.handle(input),
    log: deps.log,
  });

  const stops: Array<() => void> = [];
  let lastRevocationCheck = clock.now().toISOString();
  let specBusy = false;

  const pollRevocations = () => {
    const now = clock.now().toISOString();
    const revoked = store.revokedSince(lastRevocationCheck);
    const expired = store.expiredBetween(lastRevocationCheck, now);
    lastRevocationCheck = now;
    if (revoked.length > 0) registry.closeTokens(revoked, "token revoked");
    if (expired.length > 0) registry.closeTokens(expired, "token expired");
  };

  const drainSpecJobs = async () => {
    if (specBusy) return;
    specBusy = true;
    try {
      for (let i = 0; i < 20 && await spec.processNext(); i += 1) { /* 積まれた分を順に処理する */ }
    } catch (error) {
      deps.log(`spec job loop failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      specBusy = false;
    }
  };

  return {
    registry,
    async start() {
      stops.push(deps.discord.onMessage((channelId, message) => {
        void registry.deliverDiscordMessage(channelId, message, (userId, id) => discordService.canStillRead(userId, id));
      }));
      stops.push(deps.discord.onMemberLeave((userId) => { registry.closeUser(userId); }));
      const revocation = setInterval(() => {
        try { pollRevocations(); } catch (error) { deps.log(`revocation poll failed: ${String(error)}`); }
      }, REVOCATION_POLL_MS);
      revocation.unref?.();
      stops.push(() => clearInterval(revocation));
      const specTimer = setInterval(() => { void drainSpecJobs(); }, SPEC_JOB_POLL_MS);
      specTimer.unref?.();
      stops.push(() => clearInterval(specTimer));
      return server.listen(config.port, config.host);
    },
    async stop() {
      for (const stop of stops.splice(0)) stop();
      registry.closeAll(GOING_AWAY, "server shutting down");
      await server.close();
    },
  };
}
