import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  REST,
  Routes,
} from "discord.js";
import type { DiscordPendingQuestionsRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import injectCommand, { dispatchModalSubmit } from "./commands/inject.js";
import spawnCommand from "./commands/spawn.js";
import skillCommand from "./commands/skill.js";
import keysCommand from "./commands/keys.js";
import answerCommand from "./commands/answer.js";
import statCommand from "./commands/stat.js";
import chitchatCommand from "./commands/chitchat.js";
import consultationCommand from "./commands/consultation.js";
import endSessionCommand from "./commands/end-session.js";
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

const COMMANDS: DiscordCommandSpec[] = [
  injectCommand,
  spawnCommand,
  skillCommand,
  keysCommand,
  answerCommand,
  statCommand,
  chitchatCommand,
  consultationCommand,
  endSessionCommand,
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
    return;
  }
  if (interaction.isModalSubmit()) {
    await dispatchModalSubmit(interaction, deps);
  }
}
