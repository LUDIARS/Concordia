import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia } from "./_util.js";
import { executeSiteSpawn } from "./spawn-site.js";
import { memoriaTaskCache, toTaskChoices } from "../memoria-task-cache.js";
import { toTeamChoices } from "../team-choices.js";
import {
  effortOptions,
  guardSubsidiarySpawn,
  knownSessionIds,
  markExplicitSpawnThread,
  resolveSpawnTarget,
  resolveSpawnTeam,
  respondSiteChoices,
  siteSpawnForum,
  waitForSessionChannel,
} from "./spawn-shared.js";

const providers = ["claude", "codex", "gemini"] as const;

/**
 * `/spawn-plain` — provider + model を直接指定してセッションを起動する。
 * Delegation テンプレートからの起動 (`/spawn`) と分けた (2026-10-14 neco 指示)。
 */
const spawnPlainCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("spawn-plain")
    .setDescription("provider と model を直接指定してセッションを起動する")
    .addStringOption((o) =>
      o.setName("provider").setDescription("provider").setRequired(true).addChoices(
        { name: "claude", value: "claude" },
        { name: "codex", value: "codex" },
        { name: "gemini", value: "gemini" },
      ))
    .addStringOption((o) => o.setName("model").setDescription("モデル (例 haiku / sonnet / opus)").setRequired(false))
    .addStringOption((o) =>
      o.setName("effort")
        .setDescription("reasoning effort (未指定なら provider 既定)")
        .setRequired(false)
        .addChoices(
          { name: "low", value: "low" },
          { name: "medium", value: "medium" },
          { name: "high", value: "high" },
          { name: "xhigh", value: "xhigh" },
          { name: "max", value: "max" },
        ))
    .addStringOption((o) =>
      o.setName("prompt").setDescription("初回プロンプト (自由テキスト)。新セッション起動直後に注入する").setRequired(false))
    .addStringOption((o) => o.setName("project").setDescription("project/repository name under workspace roots").setRequired(false))
    .addStringOption((o) =>
      o.setName("team")
        .setDescription("登録済みチーム (未指定ならチーム面での実行から自動判定)")
        .setRequired(false)
        .setAutocomplete(true))
    .addStringOption((o) =>
      o.setName("task")
        .setDescription("Memoria の未完了タスク。 本文を注入し、正常終了時に done にする")
        .setRequired(false)
        .setAutocomplete(true))
    .addStringOption((o) => o.setName("branch").setDescription("requested working branch (Cc に登録)").setRequired(false))
    .addStringOption((o) => o.setName("cwd").setDescription("individual project working directory").setRequired(false))
    .addStringOption((o) =>
      o.setName("site")
        .setDescription("起動先の拠点 (未指定なら本社)。拠点の Cc で起動し、発言はスレッドで中継する")
        .setRequired(false)
        .setAutocomplete(true)),

  async autocomplete(interaction, deps) {
    const focusedOption = interaction.options.getFocused(true);
    const focused = String(focusedOption.value ?? "").toLowerCase();
    if (focusedOption.name === "team") {
      // 子会社 guild で本社 / 他社の team 名を補完候補に出さない。
      const teams = deps.subsidiaryId ? deps.teams?.listForSubsidiary(deps.subsidiaryId) ?? [] : deps.teams?.list() ?? [];
      await interaction.respond(toTeamChoices(teams, focused));
      return;
    }
    if (focusedOption.name === "site") {
      await respondSiteChoices(interaction, deps, focused);
      return;
    }
    if (focusedOption.name === "task") {
      // Memoria task は子会社 scope を持たない。本社のタスク名・本文を出張先に漏らさない。
      const memoria = deps.memoria;
      if (deps.subsidiaryId || !memoria) {
        await interaction.respond([]);
        return;
      }
      const tasks = await memoriaTaskCache.get(() => memoria.listOpenTasks(), deps.log);
      await interaction.respond(toTaskChoices(tasks, focused));
      return;
    }
    await interaction.respond([]);
  },

  async execute(interaction, deps) {
    const provider = interaction.options.getString("provider") as (typeof providers)[number] | null;
    const prompt = interaction.options.getString("prompt")?.trim() || undefined;
    const model = interaction.options.getString("model")?.trim() || undefined;
    const effort = interaction.options.getString("effort")?.trim() || undefined;
    const cwd = interaction.options.getString("cwd") ?? undefined;
    const project = interaction.options.getString("project")?.trim() || undefined;
    const requestedTeam = interaction.options.getString("team")?.trim() || undefined;
    const task = interaction.options.getString("task")?.trim() || undefined;
    const branch = interaction.options.getString("branch")?.trim() || undefined;
    const site = interaction.options.getString("site")?.trim() || undefined;
    if (!provider) {
      await interaction.reply({ content: "provider を指定してください。", ephemeral: true });
      return;
    }

    const target = await resolveSpawnTarget(interaction, deps, { site, project, task });
    if (target.kind === "cancelled") return;
    if (target.kind === "site" && deps.spawnSites) {
      if (task) {
        await target.ix.reply({ content: "拠点で起動するときは `task` を指定できません。作業内容は `prompt` で指定してください。", ephemeral: true });
        return;
      }
      deps.log.info(`spawn-plain command branch=site site=${target.site} via=${target.via} provider=${provider} user=${interaction.user.id}`);
      await executeSiteSpawn(target.ix, deps.spawnSites, target.site, {
        provider, inject: false, prompt, model, effort, project, branch, cwd,
      }, deps.log, siteSpawnForum(deps));
      return;
    }
    const ix = target.ix;
    if (!await guardSubsidiarySpawn(interaction, deps, { project, cwd, task })) return;

    const team = resolveSpawnTeam(interaction, deps, requestedTeam);
    if (!project && !cwd && !team) {
      await ix.reply({
        content: "作業対象プロジェクトを特定できません。`project`、個別リポジトリの `cwd`、または `team` を指定してください。Castra 直下では起動しません。",
        ephemeral: true,
      });
      return;
    }
    deps.log.info(
      `spawn-plain command execute provider=${provider} has_prompt=${prompt ? 1 : 0} model=${model ?? "-"} effort=${effort ?? "-"} ` +
      `project=${project ?? "-"} branch=${branch ?? "-"} has_cwd=${cwd ? 1 : 0} subsidiary=${deps.subsidiaryId ?? "-"} ` +
      `guild=${interaction.guildId ?? "-"} channel=${interaction.channelId}`,
    );
    const knownIds = knownSessionIds(deps);
    await ix.deferReply({ ephemeral: false });
    if (!await markExplicitSpawnThread(ix, deps)) return;

    const r = await callConcordia<{ ok: boolean; pid?: number; error?: string }>(
      deps.concordiaUrl,
      "POST",
      "/v1/admin/spawn-session",
      {
        provider,
        prompt,
        model,
        project,
        team,
        memoria_task_id: task,
        cwd,
        branch,
        ...(effort ? { options: effortOptions(provider, effort) } : {}),
        subsidiary_id: deps.subsidiaryId ?? null,
        requester_discord_user_id: interaction.user.id,
        source_discord_guild_id: interaction.guildId,
        source_discord_channel_id: interaction.channelId,
      },
    );
    if ("error" in r || !r.ok) {
      const error = "error" in r ? r.error : (r.error ?? "unknown");
      deps.log.warn(`spawn-plain command failed provider=${provider} error=${error}`);
      await ix.editReply({ content: `spawn failed: ${error}` });
      return;
    }
    const channelMention = await waitForSessionChannel(deps.sessionChannelsRepo, knownIds);
    deps.log.info(`spawn-plain command ok provider=${provider} pid=${r.pid ?? "n/a"} channel_found=${channelMention ? 1 : 0}`);
    await ix.editReply({
      content: channelMention
        ? `Spawned \`${provider}\`${model ? ` (${model})` : ""}${branch ? ` on \`${branch}\`` : ""} → ${channelMention}`
        : `Spawn requested (pid: ${r.pid ?? "n/a"})`,
    });
  },
};

export default spawnPlainCommand;
