import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia } from "./_util.js";
import { executeSiteSpawn } from "./spawn-site.js";
import { delegationTemplateCache } from "../delegation-template-cache.js";
import {
  guardSubsidiarySpawn,
  knownSessionIds,
  markExplicitSpawnThread,
  resolveSpawnTarget,
  resolveSpawnTeam,
  respondSiteChoices,
  siteSpawnForum,
  waitForSessionChannel,
} from "./spawn-shared.js";

/**
 * `/spawn` — Delegation テンプレートからセッションを起動する (2026-10-14 neco 指示)。
 *
 * 指定は template → site → project の 3 つだけ。 provider / model / effort / 既定 cwd は
 * テンプレート、 起動先は拠点、 作業場所は project の設定から決める。 テンプレートの prompt は
 * 注入せず、 依頼は起動したスレッドで伝える。 provider + model を直接指定する起動は `/spawn-plain`。
 */
const spawnCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("spawn")
    .setDescription("Delegation テンプレートからセッションを起動する (model 指定は /spawn-plain)")
    .addStringOption((o) =>
      o.setName("template")
        .setDescription("Delegation テンプレート — provider / model / effort / 既定 cwd を継承")
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption((o) =>
      o.setName("site")
        .setDescription("起動先の拠点 (未指定なら project の担当拠点、無ければ本社)")
        .setRequired(false)
        .setAutocomplete(true))
    .addStringOption((o) => o.setName("project").setDescription("作業対象のプロジェクト").setRequired(false)),

  async autocomplete(interaction, deps) {
    const focusedOption = interaction.options.getFocused(true);
    const focused = String(focusedOption.value ?? "").toLowerCase();
    if (focusedOption.name === "site") {
      await respondSiteChoices(interaction, deps, focused);
      return;
    }
    const cached = await delegationTemplateCache.get(deps.concordiaUrl, deps.log);
    const choices = cached.templates
      .filter((t) => t.is_active !== false)
      .filter((t) => !t.call_only)
      .filter((t) => !focused || t.call_name.toLowerCase().includes(focused) || t.title.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((t) => ({ name: `${t.emoji ? t.emoji + " " : ""}${t.call_name} — ${t.title}`.slice(0, 100), value: t.call_name }));
    deps.log.info(`spawn autocomplete respond templates=${cached.templates.length} choices=${choices.length} source=${cached.source}`);
    await interaction.respond(choices);
  },

  async execute(interaction, deps) {
    const template = interaction.options.getString("template")?.trim() ?? "";
    const site = interaction.options.getString("site")?.trim() || undefined;
    const project = interaction.options.getString("project")?.trim() || undefined;
    if (!template) {
      await interaction.reply({ content: "template を指定してください。", ephemeral: true });
      return;
    }

    const target = await resolveSpawnTarget(interaction, deps, { site, project });
    if (target.kind === "cancelled") return;
    if (target.kind === "site" && deps.spawnSites) {
      deps.log.info(`spawn command branch=site site=${target.site} via=${target.via} template=${template} user=${interaction.user.id}`);
      await executeSiteSpawn(target.ix, deps.spawnSites, target.site, { template, inject: false, project }, deps.log, siteSpawnForum(deps));
      return;
    }
    const ix = target.ix;
    if (!await guardSubsidiarySpawn(interaction, deps, { project })) return;

    const team = resolveSpawnTeam(interaction, deps);
    deps.log.info(
      `spawn command execute template=${template} project=${project ?? "-"} team=${team ?? "-"} ` +
      `subsidiary=${deps.subsidiaryId ?? "-"} guild=${interaction.guildId ?? "-"} channel=${interaction.channelId}`,
    );
    const knownIds = knownSessionIds(deps);
    await ix.deferReply({ ephemeral: false });
    if (!await markExplicitSpawnThread(ix, deps)) return;

    const cached = await delegationTemplateCache.get(deps.concordiaUrl, deps.log);
    const templateProvider = cached.templates.find((candidate) => candidate.call_name === template)?.target_provider ?? null;
    // model / effort の再評価は spawn 前ではなく、 session.started 後の契約 (contract lifecycle) が行う。
    const r = await callConcordia<{ ok: boolean; pid?: number; error?: string }>(
      deps.concordiaUrl,
      "POST",
      "/v1/admin/spawn-session",
      {
        template,
        inject_prompt: false,
        project,
        team,
        subsidiary_id: deps.subsidiaryId ?? null,
        requester_discord_user_id: interaction.user.id,
        source_discord_guild_id: interaction.guildId,
        source_discord_channel_id: interaction.channelId,
        ...(templateProvider ? { provider: templateProvider } : {}),
      },
    );
    if ("error" in r || !r.ok) {
      const error = "error" in r ? r.error : (r.error ?? "unknown");
      deps.log.warn(`spawn command template failed template=${template} error=${error}`);
      await ix.editReply({ content: `spawn failed: ${error}` });
      return;
    }
    const channelMention = await waitForSessionChannel(deps.sessionChannelsRepo, knownIds);
    deps.log.info(`spawn command template ok template=${template} pid=${r.pid ?? "n/a"} channel_found=${channelMention ? 1 : 0}`);
    await ix.editReply({
      content: channelMention
        ? `Spawned from \`${template}\` → ${channelMention}`
        : `spawn accepted for \`${template}\` (pid: ${r.pid ?? "n/a"}), but no session registered within 12 seconds. Check the Lictor runtime and try again.`,
    });
  },
};

export default spawnCommand;
