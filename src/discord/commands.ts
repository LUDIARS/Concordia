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

export interface DiscordCommandDeps {
  concordiaUrl: string;
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

export async function registerGuildCommands(token: string, applicationId: string, guildId: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const body = COMMANDS.map((c) => c.builder.toJSON());
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body });
}

export async function dispatchInteraction(interaction: Interaction, deps: DiscordCommandDeps): Promise<void> {
  if (interaction.isChatInputCommand()) {
    const cmd = COMMANDS.find((c) => c.builder.name === interaction.commandName);
    if (!cmd) return;
    await cmd.execute(interaction, deps);
    return;
  }
  if (interaction.isAutocomplete()) {
    const cmd = COMMANDS.find((c) => c.builder.name === interaction.commandName);
    if (cmd?.autocomplete) await cmd.autocomplete(interaction, deps);
    return;
  }
  if (isPermissionInteraction(interaction)) {
    await dispatchPermissionInteraction(interaction, deps);
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
  }
}
