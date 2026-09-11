import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { PublicationService } from "../ai-notes/publication-service.js";
import { SqlitePublicationStore } from "../db/ai-note-publication.js";
import { sendDiscordPublication, verifyDiscordPublication, type DiscordPublicationDeps } from "../ai-notes/discord-delivery.js";
import { sendSlackPublication, verifySlackPublication, type SlackPublicationDeps } from "../ai-notes/slack-delivery.js";

export function createAiNotePublication(input: {
  db: Database.Database;
  discordConfig: DiscordPublicationDeps["config"];
  slackConfig: SlackPublicationDeps["config"];
}): PublicationService {
  const discord = { config: input.discordConfig, fetcher: fetch };
  const slack = { config: input.slackConfig, fetcher: fetch };
  return new PublicationService(new SqlitePublicationStore(input.db), {
    send: (row, ownsAttempt) => row.target.kind === "slack-channel"
      ? sendSlackPublication(slack, { ...row, target: row.target }, ownsAttempt)
      : sendDiscordPublication(discord, { ...row, target: row.target }, ownsAttempt),
    verify: (row, messageId, channelId) => row.target.kind === "slack-channel"
      ? verifySlackPublication(slack, { ...row, target: row.target }, messageId, channelId)
      : verifyDiscordPublication(discord, { ...row, target: row.target }, messageId, channelId),
  }, Date.now, randomUUID);
}
