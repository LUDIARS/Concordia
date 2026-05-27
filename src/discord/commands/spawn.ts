import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia } from "./_util.js";

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
    const r = await callConcordia<{ ok: boolean; pid?: number; error?: string }>(
      deps.concordiaUrl,
      "POST",
      "/v1/spawn",
      { provider, cwd },
    );
    if ("error" in r || !r.ok) {
      await interaction.reply({ content: `spawn failed: ${"error" in r ? r.error : (r.error ?? "unknown")}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: `Spawn requested (pid: ${r.pid ?? "n/a"})`, ephemeral: true });
  },
};

export default spawnCommand;
