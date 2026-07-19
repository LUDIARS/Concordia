import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia } from "./_util.js";
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
    .addStringOption((o) => o.setName("project").setDescription("project/repository name under workspace roots").setRequired(false))
    .addStringOption((o) => o.setName("branch").setDescription("requested working branch (Cc に登録)").setRequired(false))
    .addStringOption((o) => o.setName("cwd").setDescription("individual project working directory").setRequired(false)),

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
    const project = interaction.options.getString("project")?.trim() || undefined;
    const branch = interaction.options.getString("branch")?.trim() || undefined;

    deps.log.info(
      `spawn command execute provider=${provider ?? "-"} template=${template ?? "-"} inject=${inject ? 1 : 0} ` +
       `has_prompt=${prompt ? 1 : 0} model=${model ?? "-"} project=${project ?? "-"} branch=${branch ?? "-"} has_cwd=${cwd ? 1 : 0} ` +
      `subsidiary=${deps.subsidiaryId ?? "-"} guild=${interaction.guildId ?? "-"} channel=${interaction.channelId}`,
    );

    // 本社はどのチャンネルからでも spawn 可 (2026-07-02 ユーザ指示でチャンネル限定を撤回)。
    // 子会社の spawn 禁止は dispatchInteraction の全コマンド拒否で担保している。

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
        { template, inject_prompt: inject, project, cwd, branch, subsidiary_id: deps.subsidiaryId ?? null },
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

    // ── provider 直接指定 ───────────────────────────────────────
    if (!provider) {
      deps.log.warn("spawn command rejected missing provider and template");
      await interaction.reply({ content: "provider か template のどちらかを指定してください。", ephemeral: true });
      return;
    }
    if (!project && !cwd) {
      await interaction.reply({
        content: "作業対象プロジェクトを特定できません。`project` または個別リポジトリの `cwd` を指定してください。Castra 直下では起動しません。",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply({ ephemeral: false });
    deps.log.info(`spawn command branch=admin-provider provider=${provider} project=${project ?? "-"} requested_branch=${branch ?? "-"}`);
    const r = await callConcordia<{ ok: boolean; pid?: number; injected_prompt?: boolean; error?: string }>(
      deps.concordiaUrl,
      "POST",
      "/v1/admin/spawn-session",
      { provider, prompt, model, project, cwd, branch, subsidiary_id: deps.subsidiaryId ?? null },
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
        ? `Spawned \`${provider}\`${model ? ` (${model})` : ""}${branch ? ` on \`${branch}\`` : ""} → ${channelMention}`
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
