import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia } from "./_util.js";
import { readSpawnToken } from "../../control/token.js";

const providers = ["claude", "codex", "gemini"] as const;

const spawnCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("spawn")
    .setDescription("Spawn a new session")
    .addStringOption((o) =>
      o.setName("provider").setDescription("provider").setRequired(true).addChoices(
        { name: "claude", value: "claude" },
        { name: "codex", value: "codex" },
        { name: "gemini", value: "gemini" },
      ))
    .addStringOption((o) => o.setName("cwd").setDescription("working directory").setRequired(false)),
  async execute(interaction, deps) {
    const provider = interaction.options.getString("provider", true) as (typeof providers)[number];
    const cwd = interaction.options.getString("cwd") ?? undefined;
    // /v1/spawn requires the Bearer token from `<cwd>/.spawn.token`. The bot
    // runs in-process with Concordia so it can read the file directly. Without
    // this the endpoint replies "missing or invalid token" (see api/spawn.ts).
    const token = readSpawnToken();
    if (!token) {
      await interaction.reply({
        content: "spawn failed: .spawn.token not found (Concordia hasn't generated it yet?)",
        ephemeral: true,
      });
      return;
    }
    const r = await callConcordia<{ ok: boolean; pid?: number; error?: string }>(
      deps.concordiaUrl,
      "POST",
      "/v1/spawn",
      { provider, cwd },
      token,
    );
    if ("error" in r || !r.ok) {
      await interaction.reply({ content: `spawn failed: ${"error" in r ? r.error : (r.error ?? "unknown")}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: `Spawn requested (pid: ${r.pid ?? "n/a"})`, ephemeral: true });
  },
};

export default spawnCommand;
