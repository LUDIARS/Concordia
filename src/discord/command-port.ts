import type { AutocompleteInteraction, ChatInputCommandInteraction, Guild } from "discord.js";
import type { DiscordPendingQuestionsRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { AnswerQuestionFn } from "../platform/answer-question.js";
import type { DiscordConfigSnapshot } from "./config.js";
import type { PermissionActionStore } from "./permission-port.js";

export interface DiscordCommandDeps {
  concordiaUrl: string;
  sessionsRepo: SessionsRepo;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  pendingQuestionsRepo: DiscordPendingQuestionsRepo;
  answerQuestion?: AnswerQuestionFn;
  guild: Guild;
  layout: DiscordConfigSnapshot;
  log: { info: (message: string) => void; warn: (message: string) => void };
  logsDir?: string;
  permissionActions?: PermissionActionStore;
  resolveWorkspaceRoots?: () => string[];
  subsidiaryId?: string | null;
}

export interface DiscordCommandSpec {
  builder: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction, deps: DiscordCommandDeps) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction, deps: DiscordCommandDeps) => Promise<void>;
}
