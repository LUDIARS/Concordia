/**
 * @implements spec/feature/discord-ui-pr-b.md — Discord `/end-session` command
 * @implements spec/tasks/2026-08-31-reconciliation-review-followup-recheck.md
 */
import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { isForumSessionThread, updateForumSessionState } from "../forum-session.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

const END_SESSION_REQUEST_TIMEOUT_MS = 10_000;

const endSessionCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder().setName("end-session").setDescription("End current session"),
  async execute(interaction, deps) {
    await interaction.deferReply({ ephemeral: true });
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    const result = await callConcordia<{ ok: boolean }>(
      deps.concordiaUrl,
      "DELETE",
      `/v1/sessions/${encodeURIComponent(session.sessionId)}`,
      undefined,
      AbortSignal.timeout(END_SESSION_REQUEST_TIMEOUT_MS),
    );
    if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true) {
      // Upstream error bodies and persisted session IDs are untrusted log input.
      deps.log.warn("end-session DELETE failed");
      await interaction.editReply({ content: "Session end failed. Please retry." });
      return;
    }
    await interaction.editReply({ content: "Session end requested." });
    if (isForumSessionThread(interaction.channel)) {
      try {
        await updateForumSessionState(interaction.channel, "ended");
      } catch (error) {
        deps.log.warn(`end-session forum close failed channel=${interaction.channelId}: ${(error as Error).message}`);
      }
    }
  },
};

export default endSessionCommand;
