import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  REST,
  Routes,
} from "discord.js";
import type { DiscordPendingQuestionsRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import spawnCommand from "./commands/spawn.js";
import skillCommand from "./commands/skill.js";
import statCommand from "./commands/stat.js";
import prsCommand from "./commands/prs.js";
import endSessionCommand from "./commands/end-session.js";
import enterCommand from "./commands/enter.js";
import { dispatchQuestionInteraction } from "./question.js";

export interface DiscordCommandDeps {
  concordiaUrl: string;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  pendingQuestionsRepo: DiscordPendingQuestionsRepo;
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
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await dispatchQuestionInteraction(interaction, deps);
  }
  // Modal submits used to feed the now-removed `/inject` command. No other
  // surface produces modal submissions, so we silently ignore them.
}
