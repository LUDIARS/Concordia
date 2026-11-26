/**
 * GLab-UnityHub worker (Excubitor code `concordia-glab-unity-hub`) の入口。
 *
 * Concordia の拡張モジュール glab-unity-hub を別プロセスで動かす composition root。
 * 設定・鍵を集め、 adapter を作って runtime に渡す。 判断は runtime 以降が持つ。
 *
 * 起動条件 (足りなければ理由を出して終了する):
 * - GLab の guild id (`GLAB_UNITY_HUB_GUILD_ID` / `glabUnityHub.guildId`)
 * - 待受ポート (`GLAB_UNITY_HUB_PORT`、 catalog の env で渡す)
 * - Discord Bot token (Concordia の Discord 設定。 DB 優先、 env フォールバック)
 * - Portus (`@ludiars/portus` または `GLAB_UNITY_HUB_PORTUS_ROOT`)
 *
 * @implements spec/feature/glab-unity-hub.md §5 (GUH-ARCH)
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createChildLogger } from "./shared/logger.js";
import { loadConfig } from "./shared/config.js";
import { loadSecretBox } from "./shared/secret-box.js";
import { openDb } from "./db/index.js";
import { makeDiscordConfigRepo } from "./db/discord-repo.js";
import { resolveDiscordConfig } from "./discord/conn-config.js";
import { ExcubitorClient } from "./excubitor/client.js";
import { ActioTransport } from "./taskflow/actio-transport.js";
import { readActioBindings, type ActioBinding } from "./taskflow/actio-binding.js";
import { AnatomiaDomainClient } from "./domain-review/anatomia-client.js";
import { runAvailableText } from "./rules/available-text-runner.js";
import { loadGlabUnityHubConfig, type GlabUnityHubConfig } from "./glab-unity-hub/adapters/hub-config.js";
import { openGlabUnityHubDb, SqliteGlabUnityStore } from "./glab-unity-hub/adapters/sqlite-store.js";
import { DiscordJsGateway } from "./glab-unity-hub/adapters/discord-gateway.js";
import { NotionBoardClient } from "./glab-unity-hub/adapters/notion-boards.js";
import { LoopbackServiceHttp } from "./glab-unity-hub/adapters/service-http.js";
import { BreviariumClient } from "./glab-unity-hub/adapters/breviarium-client.js";
import { PraeformaSpecClient } from "./glab-unity-hub/adapters/praeforma-specs.js";
import { GhCliIssues } from "./glab-unity-hub/adapters/github-cli.js";
import { ActioSprintClient } from "./glab-unity-hub/adapters/actio-sprints.js";
import { CalliopeMaterials, OneShotCalliopeWriter } from "./glab-unity-hub/adapters/calliope-adapters.js";
import { loadPortus } from "./glab-unity-hub/adapters/portus-loader.js";
import { createGlabUnityHubRuntime } from "./glab-unity-hub/runtime.js";

const log = createChildLogger("glab-unity-hub");

export type RunnableConfig = GlabUnityHubConfig & { readonly guildId: string; readonly port: number };

/** 起動に足りない設定を列挙する。 空なら起動できる。 */
export function missingStartupSettings(config: GlabUnityHubConfig): string[] {
  const missing: string[] = [];
  if (!config.guildId) missing.push("GLAB_UNITY_HUB_GUILD_ID (or glabUnityHub.guildId)");
  if (config.port === null) missing.push("GLAB_UNITY_HUB_PORT (catalog env)");
  return missing;
}

/** プロジェクトコード → Actio binding (project 名の一致)。 */
export function actioBindingResolver(bindings: readonly ActioBinding[], config: Pick<GlabUnityHubConfig, "projects">): (project: string) => ActioBinding | null {
  return (project) => {
    const actioProject = config.projects.find((entry) => entry.code === project)?.actioProject ?? project;
    return bindings.find((binding) => binding.project === actioProject) ?? null;
  };
}

export async function startGlabUnityHubWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadGlabUnityHubConfig(env);
  const missing = missingStartupSettings(config);
  if (missing.length > 0) throw new Error(`GLab-UnityHub is not configured: ${missing.join(", ")}`);
  const runnable = config as RunnableConfig;

  const concordia = loadConfig(env);
  const db = openDb(concordia.dbPath);
  const secretBox = loadSecretBox({ envValue: env.CONCORDIA_SECRET_KEY, keyFile: join(process.cwd(), "concordia.secret.key") });
  const discordEnv = resolveDiscordConfig(makeDiscordConfigRepo(db), secretBox, env);
  if (!discordEnv.token) throw new Error("Discord Bot token is not configured (Concordia Discord settings)");

  const portus = await loadPortus(env);
  const store = new SqliteGlabUnityStore(openGlabUnityHubDb(runnable.dbPath));
  const client = DiscordJsGateway.createClient();
  await client.login(discordEnv.token);
  const discord = new DiscordJsGateway(client, runnable.guildId, {
    bugReportChannelId: runnable.bugReportChannelId, notifyUserId: runnable.notifyUserId,
  });
  const catalog = new ExcubitorClient();
  const http = new LoopbackServiceHttp(catalog);
  const projects = runnable.projects.map((project) => project.code);
  const bindings = (() => {
    try {
      return readActioBindings(env);
    } catch (error) {
      log.warn(`Actio bindings are unavailable; sprint methods will fail: ${(error as Error).message}`);
      return [];
    }
  })();
  const runtime = createGlabUnityHubRuntime({
    config: runnable,
    store,
    discord,
    portus,
    breviarium: new BreviariumClient(http),
    notion: new NotionBoardClient(runnable.notionBoards, env),
    actio: new ActioSprintClient(
      new ActioTransport(catalog, (name) => env[name]),
      actioBindingResolver(bindings, runnable), projects, runnable.actioWebUrl,
    ),
    praeforma: new PraeformaSpecClient(http, runnable.praeformaWebUrl),
    github: new GhCliIssues(),
    calliopeMaterials: new CalliopeMaterials({ projects: runnable.projects, anatomia: new AnatomiaDomainClient(), http, clock: { now: () => new Date() } }),
    calliopeWriter: new OneShotCalliopeWriter(runAvailableText),
    log: (message) => log.warn(message),
  });
  const port = await runtime.start();
  log.info(`GLab-UnityHub listening host=${runnable.host} port=${port} geo=${runnable.geoPolicy} allowed=${runnable.allowedCountries.join(",")}`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.stop().catch(() => undefined);
    await client.destroy();
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startGlabUnityHubWorker().catch((error: unknown) => {
    log.error({ err: error }, "GLab-UnityHub worker failed to start");
    process.exit(1);
  });
}
