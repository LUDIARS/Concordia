import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
  REST,
  Routes,
} from "discord.js";
import type { DiscordPendingQuestionsRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { DiscordConfigSnapshot } from "./config.js";
import spawnCommand from "./commands/spawn.js";
import skillCommand from "./commands/skill.js";
import statCommand from "./commands/stat.js";
import prsCommand from "./commands/prs.js";
import endSessionCommand from "./commands/end-session.js";
import enterCommand from "./commands/enter.js";
import cleanCommand from "./commands/clean.js";
import mmtaskCommand from "./commands/mmtask.js";
import projectsCommand from "./commands/projects.js";
import chNameCommand from "./commands/ch-name.js";
import compactionCommand from "./commands/compaction.js";
import goalCommand from "./commands/goal.js";
import relictorCommand from "./commands/relictor.js";
import { dispatchQuestionInteraction } from "./question.js";
import { dispatchPermissionInteraction, isPermissionInteraction, type PermissionActionStore } from "./permission.js";
import { handleControlInteraction, handleControlModalSubmit } from "./control.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { interactionAgeMs } from "./interaction-diagnostics.js";

export interface DiscordCommandDeps {
  concordiaUrl: string;
  sessionsRepo: SessionsRepo;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  pendingQuestionsRepo: DiscordPendingQuestionsRepo;
  guild: Guild;
  layout: DiscordConfigSnapshot;
  log: { info: (m: string) => void; warn: (m: string) => void };
  logsDir?: string;
  permissionActions?: PermissionActionStore;
  /** 子会社 Bot から呼ばれた場合の子会社 id。 /spawn が spawn したセッションへ焼く。 本社は null。 */
  subsidiaryId?: string | null;
}

export interface DiscordCommandSpec {
  builder: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction, deps: DiscordCommandDeps) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction, deps: DiscordCommandDeps) => Promise<void>;
}

// User-facing slash commands.
const COMMANDS: DiscordCommandSpec[] = [
  spawnCommand,
  skillCommand,
  statCommand,
  prsCommand,
  endSessionCommand,
  enterCommand,
  cleanCommand,
  mmtaskCommand,
  projectsCommand,
  chNameCommand,
  compactionCommand,
  goalCommand,
  relictorCommand,
];

const SUBSIDIARY_ALLOWED_COMMAND_NAMES = new Set(["ch_name"]);

export function isSubsidiaryAllowedCommand(name: string): boolean {
  return SUBSIDIARY_ALLOWED_COMMAND_NAMES.has(name);
}

export function commandNamesForRegistration(opts: { subsidiary?: boolean } = {}): string[] {
  return COMMANDS
    .filter((c) => !opts.subsidiary || isSubsidiaryAllowedCommand(c.builder.name))
    .map((c) => c.builder.name);
}

export async function registerGuildCommands(
  token: string,
  applicationId: string,
  guildId: string,
  opts: { subsidiary?: boolean } = {},
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const allowed = new Set(commandNamesForRegistration(opts));
  const body = COMMANDS.filter((c) => allowed.has(c.builder.name)).map((c) => c.builder.toJSON());
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body });
}

/** guild の slash commands を全解除する (子会社 guild にコマンドを出さないため)。 */
export async function clearGuildCommands(token: string, applicationId: string, guildId: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: [] });
}

export async function dispatchInteraction(interaction: Interaction, deps: DiscordCommandDeps): Promise<void> {
  // 子会社 guild では許可リスト外の Discord コマンドを拒否する。作業依頼 / spawn 系は
  // 受付チャンネルのメッセージ → ガードゲート経由のみ。過去登録済みの guild からの
  // 残存コマンド実行もここで確実に弾く (二段防御)。
  if (
    deps.subsidiaryId &&
    "commandName" in interaction &&
    !isSubsidiaryAllowedCommand(String(interaction.commandName))
  ) {
    deps.log.warn(
      `discord interaction rejected (subsidiary) subsidiary=${deps.subsidiaryId} ` +
      `type=${interaction.type} name=${"commandName" in interaction ? String(interaction.commandName) : "-"}`,
    );
    if (interaction.isAutocomplete()) {
      await interaction.respond([]).catch(() => { /* best-effort */ });
    } else if (interaction.isRepliable()) {
      await interaction.reply({
        content: "このサーバでは Discord コマンドは利用できません。依頼は受付チャンネルへメッセージでどうぞ。",
        ephemeral: true,
      }).catch(() => { /* best-effort */ });
    }
    return;
  }
  if (interaction.isChatInputCommand()) {
    const age = interactionAgeMs(interaction);
    deps.log.info(
      `discord command received name=${interaction.commandName} guild=${interaction.guildId ?? "-"} ` +
      `channel=${interaction.channelId ?? "-"} user=${interaction.user?.id ?? "-"} ` +
      `age_ms=${age ?? "-"}`,
    );
    const cmd = COMMANDS.find((c) => c.builder.name === interaction.commandName);
    if (!cmd) {
      deps.log.warn(`discord command ignored unknown name=${interaction.commandName}`);
      return;
    }
    await cmd.execute(interaction, deps);
    return;
  }
  if (interaction.isAutocomplete()) {
    const age = interactionAgeMs(interaction);
    deps.log.info(
      `discord autocomplete received name=${interaction.commandName} guild=${interaction.guildId ?? "-"} ` +
      `channel=${interaction.channelId ?? "-"} user=${interaction.user?.id ?? "-"} ` +
      `age_ms=${age ?? "-"}`,
    );
    const cmd = COMMANDS.find((c) => c.builder.name === interaction.commandName);
    if (cmd?.autocomplete) {
      await cmd.autocomplete(interaction, deps);
    } else {
      deps.log.warn(`discord autocomplete ignored name=${interaction.commandName}`);
    }
    return;
  }
  if (isPermissionInteraction(interaction)) {
    await dispatchPermissionInteraction(interaction, deps);
    return;
  }
  if (
    (interaction.isButton() || interaction.isStringSelectMenu()) &&
    interaction.customId.startsWith("ctrl:")
  ) {
    await handleControlInteraction(interaction, {
      concordiaUrl: deps.concordiaUrl,
      sessionsRepo: deps.sessionsRepo,
      sessionChannelsRepo: deps.sessionChannelsRepo,
      log: deps.log,
    });
    return;
  }
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await dispatchQuestionInteraction(interaction, deps);
    return;
  }
  // Modal submits: AskUserQuestion の「その他 (自由入力)」(customId `qothm:`)。
  // 他の modal surface は無いので、それ以外は無視。
  if (interaction.isModalSubmit() && interaction.customId.startsWith("qothm:")) {
    await dispatchQuestionInteraction(interaction, deps);
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("ctrl:")) {
    await handleControlModalSubmit(interaction, { concordiaUrl: deps.concordiaUrl, log: deps.log });
  }
}
