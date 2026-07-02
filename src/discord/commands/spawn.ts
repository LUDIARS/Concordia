import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia } from "./_util.js";
import { readSpawnToken } from "../../control/token.js";
import { delegationTemplateCache } from "../delegation-template-cache.js";

const providers = ["claude", "codex", "gemini"] as const;

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
    .addStringOption((o) =>
      o.setName("prompt")
        .setDescription("初回プロンプト (自由テキスト)。新セッション起動直後に注入する")
        .setRequired(false))
    .addStringOption((o) =>
      o.setName("model")
        .setDescription("モデル (例 haiku / sonnet / opus)。provider 直指定時のみ有効")
        .setRequired(false))
    .addStringOption((o) => o.setName("cwd").setDescription("working directory").setRequired(false)),

  async autocomplete(interaction, deps) {
    const focused = interaction.options.getFocused().toLowerCase();
    deps.log.info(
      `spawn autocomplete start guild=${interaction.guildId ?? "-"} channel=${interaction.channelId ?? "-"} ` +
      `focused_len=${focused.length}`,
    );
    const cached = await delegationTemplateCache.get(deps.concordiaUrl, deps.log);
    const templates = cached.templates;
    const choices = templates
      .filter((t) => t.is_active !== false)
      .filter((t) => !t.call_only)
      .filter((t) => !focused || t.call_name.toLowerCase().includes(focused) || t.title.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((t) => ({ name: `${t.emoji ? t.emoji + " " : ""}${t.call_name} — ${t.title}`.slice(0, 100), value: t.call_name }));
    deps.log.info(
      `spawn autocomplete respond templates=${templates.length} choices=${choices.length} ` +
      `source=${cached.source} refreshing=${cached.refreshing ? 1 : 0}`,
    );
    await interaction.respond(choices);
  },

  async execute(interaction, deps) {
    const provider = interaction.options.getString("provider") as (typeof providers)[number] | null;
    const template = interaction.options.getString("template") ?? undefined;
    const inject = interaction.options.getBoolean("inject") ?? false;
    const prompt = interaction.options.getString("prompt")?.trim() || undefined;
    const model = interaction.options.getString("model")?.trim() || undefined;
    const cwd = interaction.options.getString("cwd") ?? undefined;

    deps.log.info(
      `spawn command execute provider=${provider ?? "-"} template=${template ?? "-"} inject=${inject ? 1 : 0} ` +
      `has_prompt=${prompt ? 1 : 0} model=${model ?? "-"} has_cwd=${cwd ? 1 : 0} ` +
      `subsidiary=${deps.subsidiaryId ?? "-"} guild=${interaction.guildId ?? "-"} channel=${interaction.channelId}`,
    );

    // spawn は「あらかじめ用意されたチャンネル」 (#spawn, ensureDiscordLayout が自動作成)
    // でのみ受け付ける。 spawnChannelId が空 = この guild では spawn 不可 (子会社等)。
    if (!deps.layout.spawnChannelId) {
      deps.log.warn(`spawn command rejected: spawn channel not provisioned guild=${interaction.guildId ?? "-"}`);
      await interaction.reply({ content: "このサーバでは /spawn は利用できません。", ephemeral: true });
      return;
    }
    if (interaction.channelId !== deps.layout.spawnChannelId) {
      deps.log.warn(
        `spawn command rejected: wrong channel channel=${interaction.channelId} allowed=${deps.layout.spawnChannelId}`,
      );
      await interaction.reply({
        content: `/spawn は <#${deps.layout.spawnChannelId}> でのみ実行できます。`,
        ephemeral: true,
      });
      return;
    }

    // スポーン前のアクティブセッション ID を記録し、新規セッションチャンネルを特定する。
    const knownIds = new Set(deps.sessionChannelsRepo.listActive().map((r) => r.session_id));

    // ── template 起動経路 ───────────────────────────────────────
    // /v1/admin/spawn-session は loopback 信頼境界に乗るので token 不要。
    // provider / model / 既定 cwd はテンプレから継承する。
    if (template) {
      await interaction.deferReply({ ephemeral: false });
      deps.log.info(`spawn command branch=template template=${template} inject=${inject ? 1 : 0}`);
      const r = await callConcordia<{ ok: boolean; pid?: number; injected_prompt?: boolean; error?: string }>(
        deps.concordiaUrl,
        "POST",
        "/v1/admin/spawn-session",
        { template, inject_prompt: inject, cwd, subsidiary_id: deps.subsidiaryId ?? null },
      );
      if ("error" in r || !r.ok) {
        deps.log.warn(`spawn command template failed template=${template} error=${"error" in r ? r.error : (r.error ?? "unknown")}`);
        await interaction.editReply({
          content: `spawn failed: ${"error" in r ? r.error : (r.error ?? "unknown")}`,
        });
        return;
      }
      const channelMention = await waitForSessionChannel(deps.sessionChannelsRepo, knownIds);
      deps.log.info(`spawn command template ok template=${template} pid=${r.pid ?? "n/a"} channel_found=${channelMention ? 1 : 0}`);
      await interaction.editReply({
        content: channelMention
          ? `Spawned from \`${template}\`${r.injected_prompt ? " (prompt 注入)" : ""} → ${channelMention}`
          : `Spawned from \`${template}\` (pid: ${r.pid ?? "n/a"}${r.injected_prompt ? ", prompt 注入" : ""})`,
      });
      return;
    }

    // ── 従来経路: provider 直接指定 (/v1/spawn は token 必須) ──────
    if (!provider) {
      deps.log.warn("spawn command rejected missing provider and template");
      await interaction.reply({ content: "provider か template のどちらかを指定してください。", ephemeral: true });
      return;
    }
    // prompt / model 指定あり = 自由テキスト初回プロンプト経路。/v1/admin/spawn-session
    // (loopback 信頼境界、token 不要) が prompt を prompt file 化して注入する。
    if (prompt || model) {
      await interaction.deferReply({ ephemeral: false });
      deps.log.info(`spawn command branch=admin-provider provider=${provider} model=${model ?? "-"} has_prompt=${prompt ? 1 : 0}`);
      const r = await callConcordia<{ ok: boolean; pid?: number; injected_prompt?: boolean; error?: string }>(
        deps.concordiaUrl,
        "POST",
        "/v1/admin/spawn-session",
        { provider, prompt, model, cwd, subsidiary_id: deps.subsidiaryId ?? null },
      );
      if ("error" in r || !r.ok) {
        deps.log.warn(`spawn command admin-provider failed provider=${provider} error=${"error" in r ? r.error : (r.error ?? "unknown")}`);
        await interaction.editReply({ content: `spawn failed: ${"error" in r ? r.error : (r.error ?? "unknown")}` });
        return;
      }
      const channelMention = await waitForSessionChannel(deps.sessionChannelsRepo, knownIds);
      deps.log.info(`spawn command admin-provider ok provider=${provider} pid=${r.pid ?? "n/a"} channel_found=${channelMention ? 1 : 0}`);
      await interaction.editReply({
        content: channelMention
          ? `Spawned \`${provider}\`${model ? ` (${model})` : ""}${r.injected_prompt ? " (prompt 注入)" : ""} → ${channelMention}`
          : `Spawn requested (pid: ${r.pid ?? "n/a"})`,
      });
      return;
    }
    // 子会社経路は廃止: 子会社 guild では dispatchInteraction が全コマンドを拒否する
    // (子会社は Discord コマンド不許可。 依頼は受付チャンネル → ガードゲートのみ)。
    // /v1/spawn requires the Bearer token from `<cwd>/.spawn.token`. The bot
    // runs in-process with Concordia so it can read the file directly.
    const token = readSpawnToken();
    if (!token) {
      deps.log.warn("spawn command legacy-token branch failed: .spawn.token not found");
      await interaction.reply({
        content: "spawn failed: .spawn.token not found (Concordia hasn't generated it yet?)",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply({ ephemeral: false });
    deps.log.info(`spawn command branch=legacy-token provider=${provider}`);
    const r = await callConcordia<{ ok: boolean; pid?: number; error?: string }>(
      deps.concordiaUrl,
      "POST",
      "/v1/spawn",
      { provider, cwd },
      token,
    );
    if ("error" in r || !r.ok) {
      deps.log.warn(`spawn command legacy-token failed provider=${provider} error=${"error" in r ? r.error : (r.error ?? "unknown")}`);
      await interaction.editReply({ content: `spawn failed: ${"error" in r ? r.error : (r.error ?? "unknown")}` });
      return;
    }
    const channelMention = await waitForSessionChannel(deps.sessionChannelsRepo, knownIds);
    deps.log.info(`spawn command legacy-token ok provider=${provider} pid=${r.pid ?? "n/a"} channel_found=${channelMention ? 1 : 0}`);
    await interaction.editReply({
      content: channelMention
        ? `Spawned \`${provider}\` → ${channelMention}`
        : `Spawn requested (pid: ${r.pid ?? "n/a"})`,
    });
  },
};

export default spawnCommand;

/**
 * スポーン後、新しいセッションチャンネルが DB に現れるまで最大 12s ポーリングし、
 * Discord チャンネルメンション文字列 (`<#channelId>`) を返す。見つからなければ null。
 */
async function waitForSessionChannel(
  sessionChannelsRepo: import("../../db/discord-repo.js").DiscordSessionChannelsRepo,
  knownIds: Set<string>,
  timeoutMs = 12000,
  intervalMs = 800,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    for (const row of sessionChannelsRepo.listActive()) {
      if (!knownIds.has(row.session_id) && row.channel_id) {
        return `<#${row.channel_id}>`;
      }
    }
  }
  return null;
}
