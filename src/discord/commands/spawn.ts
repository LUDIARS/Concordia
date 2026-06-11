import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia } from "./_util.js";
import { readSpawnToken } from "../../control/token.js";

const providers = ["claude", "codex", "gemini"] as const;

interface DelegationTemplateLite {
  call_name: string;
  title: string;
  is_active: boolean;
  call_only: boolean;
}

const spawnCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("spawn")
    .setDescription("Spawn a new session (provider direct, or from a delegation template)")
    .addStringOption((o) =>
      o.setName("provider").setDescription("provider (template 指定時は省略可)").setRequired(false).addChoices(
        { name: "claude", value: "claude" },
        { name: "codex", value: "codex" },
        { name: "gemini", value: "gemini" },
      ))
    .addStringOption((o) =>
      o.setName("template")
        .setDescription("delegation テンプレ call_name — provider/model/既定cwd を継承")
        .setRequired(false)
        .setAutocomplete(true))
    .addBooleanOption((o) =>
      o.setName("inject")
        .setDescription("テンプレの prompt を render して自動注入する (既定: 注入しない)")
        .setRequired(false))
    .addStringOption((o) => o.setName("cwd").setDescription("working directory").setRequired(false)),

  async autocomplete(interaction, deps) {
    const focused = interaction.options.getFocused().toLowerCase();
    const r = await callConcordia<{ templates: DelegationTemplateLite[] }>(
      deps.concordiaUrl,
      "GET",
      "/v1/delegation/templates",
    );
    const templates = "error" in r ? [] : r.templates;
    const choices = templates
      .filter((t) => t.is_active !== false)
      .filter((t) => !t.call_only)
      .filter((t) => !focused || t.call_name.toLowerCase().includes(focused) || t.title.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((t) => ({ name: `${t.call_name} — ${t.title}`.slice(0, 100), value: t.call_name }));
    await interaction.respond(choices);
  },

  async execute(interaction, deps) {
    const provider = interaction.options.getString("provider") as (typeof providers)[number] | null;
    const template = interaction.options.getString("template") ?? undefined;
    const inject = interaction.options.getBoolean("inject") ?? false;
    const cwd = interaction.options.getString("cwd") ?? undefined;

    // ── template 起動経路 ───────────────────────────────────────
    // /v1/admin/spawn-session は loopback 信頼境界に乗るので token 不要。
    // provider / model / 既定 cwd はテンプレから継承する。
    if (template) {
      const r = await callConcordia<{ ok: boolean; pid?: number; injected_prompt?: boolean; error?: string }>(
        deps.concordiaUrl,
        "POST",
        "/v1/admin/spawn-session",
        { template, inject_prompt: inject, cwd },
      );
      if ("error" in r || !r.ok) {
        await interaction.reply({
          content: `spawn failed: ${"error" in r ? r.error : (r.error ?? "unknown")}`,
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({
        content: `Spawned from \`${template}\` (pid: ${r.pid ?? "n/a"}${r.injected_prompt ? ", prompt 注入" : ""})`,
        ephemeral: true,
      });
      return;
    }

    // ── 従来経路: provider 直接指定 (/v1/spawn は token 必須) ──────
    if (!provider) {
      await interaction.reply({ content: "provider か template のどちらかを指定してください。", ephemeral: true });
      return;
    }
    // /v1/spawn requires the Bearer token from `<cwd>/.spawn.token`. The bot
    // runs in-process with Concordia so it can read the file directly.
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
