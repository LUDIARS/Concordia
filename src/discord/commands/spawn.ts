import { ChannelType, SlashCommandBuilder, type PublicThreadChannel } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia } from "./_util.js";
import { delegationTemplateCache } from "../delegation-template-cache.js";
import { memoriaTaskCache, toTaskChoices } from "../memoria-task-cache.js";
import { toTeamChoices } from "../team-choices.js";
import { resolveTeamFromChannel, type SpawnChannelChain } from "../team-channel-binding.js";
import {
  markForumThreadAsConcordiaManaged,
  type EditableForumThread,
} from "../forum-system-tag.js";
import {
  checkSubsidiarySpawnTarget,
  subsidiarySpawnDenialMessage,
} from "../../subsidiary/spawn-scope.js";

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
    .addStringOption((o) =>
      o.setName("effort")
        .setDescription("reasoning effort (未指定ならprovider/template既定)")
        .setRequired(false)
        .addChoices(
          { name: "low", value: "low" },
          { name: "medium", value: "medium" },
          { name: "high", value: "high" },
          { name: "xhigh", value: "xhigh" },
          { name: "max", value: "max" },
        ))
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
    .addStringOption((o) => o.setName("cwd").setDescription("individual project working directory").setRequired(false)),

  async autocomplete(interaction, deps) {
    const focusedOption = interaction.options.getFocused(true);
    const focused = String(focusedOption.value ?? "").toLowerCase();
    deps.log.info(
      `spawn autocomplete start option=${focusedOption.name} guild=${interaction.guildId ?? "-"} ` +
      `channel=${interaction.channelId ?? "-"} focused_len=${focused.length}`,
    );

    // team / task はテンプレとは別の候補源。 option 名で分岐しないと、どの欄を
    // 編集していてもテンプレ一覧が出る (2026-08-15 まではその状態だった)。
    if (focusedOption.name === "team") {
      // 子会社 guild で本社 / 他社の team 名を補完候補に出さない。
      const teams = deps.subsidiaryId
        ? deps.teams?.listForSubsidiary(deps.subsidiaryId) ?? []
        : deps.teams?.list() ?? [];
      await interaction.respond(toTeamChoices(teams, focused));
      return;
    }
    if (focusedOption.name === "task") {
      // Memoria task は子会社 scope を持たない。本社のタスク名・本文を出張先に
      // 漏らさないよう、scope resolver が無い間は候補を出さない。
      if (deps.subsidiaryId) {
        await interaction.respond([]);
        return;
      }
      const memoria = deps.memoria;
      if (!memoria) {
        await interaction.respond([]);
        return;
      }
      const tasks = await memoriaTaskCache.get(() => memoria.listOpenTasks(), deps.log);
      await interaction.respond(toTaskChoices(tasks, focused));
      return;
    }

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
    const effort = interaction.options.getString("effort")?.trim() || undefined;
    const cwd = interaction.options.getString("cwd") ?? undefined;
    const project = interaction.options.getString("project")?.trim() || undefined;
    const requestedTeam = interaction.options.getString("team")?.trim() || undefined;
    const task = interaction.options.getString("task")?.trim() || undefined;
    const branch = interaction.options.getString("branch")?.trim() || undefined;

    // 明示指定が最優先。 未指定のときだけ「どのチーム面で実行したか」から補う。
    // セッションはほぼ workspace root から起動されるので、起動後の付け替えでは
    // 取りこぼす (spec/feature/teams.md §2)。
    const channelTeam = requestedTeam ? null : resolveSpawnChannelTeam(interaction, deps);
    const team = requestedTeam ?? channelTeam?.teamId;
    if (channelTeam) {
      deps.log.info(
        `spawn team resolved from channel team=${channelTeam.teamId} via=${channelTeam.via} ` +
        `channel=${interaction.channelId}`,
      );
    }

    deps.log.info(
      `spawn command execute provider=${provider ?? "-"} template=${template ?? "-"} inject=${inject ? 1 : 0} ` +
       `has_prompt=${prompt ? 1 : 0} model=${model ?? "-"} effort=${effort ?? "-"} project=${project ?? "-"} branch=${branch ?? "-"} has_cwd=${cwd ? 1 : 0} ` +
      `subsidiary=${deps.subsidiaryId ?? "-"} guild=${interaction.guildId ?? "-"} channel=${interaction.channelId}`,
    );

    // 本社はどのチャンネルからでも spawn 可 (2026-07-02 ユーザ指示でチャンネル限定を撤回)。
    // 子会社は起動できるが (2026-09-01 neco 指示 1)、 起動先は関係プロジェクトに閉じる
    // (spec/feature/subsidiary-delegation.md §3.4)。 起動者の役職判定は dispatchInteraction
    // (PRIVILEGED_SESSION_SPAWN) が済ませている — ここは「どこへ起こすか」だけを見る。
    if (deps.subsidiaryId) {
      if (!deps.resolveSubsidiaryProjects) {
        // 子会社 id だけ配線されて scope resolver が欠けた構成を、本社相当の無制限にしない。
        deps.log.warn(`spawn command rejected: subsidiary project scope unavailable subsidiary=${deps.subsidiaryId}`);
        await interaction.reply({
          content: "この窓口の担当プロジェクト設定を確認できないため起動しません。",
          ephemeral: true,
        });
        return;
      }
      const scope = checkSubsidiarySpawnTarget({
        project,
        cwd,
        projects: deps.resolveSubsidiaryProjects(),
      });
      if (!scope.ok) {
        deps.log.warn(
          `spawn command rejected (subsidiary scope) subsidiary=${deps.subsidiaryId} ` +
          `denial=${scope.denial} project=${project ?? "-"} has_cwd=${cwd ? 1 : 0} user=${interaction.user.id}`,
        );
        await interaction.reply({ content: subsidiarySpawnDenialMessage(scope.denial), ephemeral: true });
        return;
      }
      if (task) {
        deps.log.warn(
          `spawn command rejected (subsidiary task scope unavailable) subsidiary=${deps.subsidiaryId} `
          + `user=${interaction.user.id}`,
        );
        await interaction.reply({
          content: "この窓口では `task` の指定を利用できません。作業内容は `prompt` で指定してください。",
          ephemeral: true,
        });
        return;
      }
    }

    // スポーン前のアクティブセッション ID を記録し、新規セッションチャンネルを特定する。
    const knownIds = new Set(deps.sessionChannelsRepo.listActive().map((r) => r.session_id));

    // ── template 起動経路 ───────────────────────────────────────
    // /v1/admin/spawn-session は loopback 信頼境界に乗るので token 不要。
    // provider / model / 既定 cwd はテンプレから継承する。
    if (template) {
      await interaction.deferReply({ ephemeral: false });
      if (!await markExplicitSpawnThread(interaction, deps)) return;
      deps.log.info(`spawn command branch=template template=${template} inject=${inject ? 1 : 0}`);
      const cached = await delegationTemplateCache.get(deps.concordiaUrl, deps.log);
      const selected = cached.templates.find((candidate) => candidate.call_name === template);
      const templateProvider = selected?.target_provider ?? null;
      const request: Record<string, unknown> = {
        template,
        inject_prompt: inject,
        project,
        team,
        memoria_task_id: task,
        cwd,
        branch,
        subsidiary_id: deps.subsidiaryId ?? null,
        requester_discord_user_id: interaction.user.id,
        source_discord_guild_id: interaction.guildId,
        source_discord_channel_id: interaction.channelId,
        ...(templateProvider ? { provider: templateProvider } : {}),
        ...(effort ? { options: effortOptions(templateProvider, effort) } : {}),
      };
      // model / effort の再評価は spawn 前の単発ダイアログではなく、 session.started 後の
      // 契約 (contract lifecycle の LLM tier) が行う (contract-absorb-model-review)。
      const r = await callConcordia<{ ok: boolean; pid?: number; injected_prompt?: boolean; error?: string }>(
        deps.concordiaUrl,
        "POST",
        "/v1/admin/spawn-session",
        request,
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
          : `spawn accepted for \`${template}\` (pid: ${r.pid ?? "n/a"}${r.injected_prompt ? ", prompt 注入" : ""}), but no session registered within 12 seconds. Check the Lictor runtime and try again.`,
      });
      return;
    }

    // ── provider 直接指定 ───────────────────────────────────────
    if (!provider) {
      deps.log.warn("spawn command rejected missing provider and template");
      await interaction.reply({ content: "provider か template のどちらかを指定してください。", ephemeral: true });
      return;
    }
    if (!project && !cwd && !team) {
      await interaction.reply({
        content: "作業対象プロジェクトを特定できません。`project`、個別リポジトリの `cwd`、または `team` を指定してください。Castra 直下では起動しません。",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply({ ephemeral: false });
    if (!await markExplicitSpawnThread(interaction, deps)) return;
    deps.log.info(`spawn command branch=admin-provider provider=${provider} project=${project ?? "-"} requested_branch=${branch ?? "-"}`);
    const request: Record<string, unknown> = {
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
    };
    const r = await callConcordia<{ ok: boolean; pid?: number; injected_prompt?: boolean; error?: string }>(
      deps.concordiaUrl,
      "POST",
      "/v1/admin/spawn-session",
      request,
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

/**
 * `/spawn` 実行チャンネルからチームを引く。 Discord 側の階層解決だけをここで行い、
 * 突き合わせ規則は team-channel-binding.ts の純関数に置く。
 * teams 未注入・ギルド外・一致なしはすべて null (現行どおりチーム未所属)。
 */
function resolveSpawnChannelTeam(
  interaction: Parameters<DiscordCommandSpec["execute"]>[0],
  deps: Parameters<DiscordCommandSpec["execute"]>[1],
): ReturnType<typeof resolveTeamFromChannel> {
  const teams = deps.teams;
  if (!teams) return null;
  const channel = interaction.channel;
  const chain: SpawnChannelChain = channel?.isThread()
    ? {
        channelId: channel.id,
        parentId: channel.parentId,
        categoryId: channel.parent?.parentId ?? null,
      }
    : {
        channelId: interaction.channelId,
        parentId: null,
        categoryId: channel && "parentId" in channel ? channel.parentId ?? null : null,
      };
  return resolveTeamFromChannel(teams, chain);
}

function effortOptions(provider: string | null, effort: string): Record<string, string> {
  return provider === "claude" ? { effort } : { model_reasoning_effort: effort };
}

export default spawnCommand;

async function markExplicitSpawnThread(
  interaction: Parameters<DiscordCommandSpec["execute"]>[0],
  deps: Parameters<DiscordCommandSpec["execute"]>[1],
): Promise<boolean> {
  const channel = interaction.channel;
  if (
    !channel?.isThread()
    || channel.type !== ChannelType.PublicThread
    || channel.parentId !== deps.layout.sessionForumId
    || channel.parent?.type !== ChannelType.GuildForum
  ) {
    return true;
  }
  try {
    await markForumThreadAsConcordiaManaged(adaptForumThread(channel));
    deps.log.info(`spawn command marked Cc-managed forum thread=${channel.id}`);
    return true;
  } catch (error) {
    const message = (error as Error).message;
    deps.log.warn(`spawn command forum tag failed thread=${channel.id}: ${message}`);
    await interaction.editReply({
      content: `spawn failed: Forum の Cc 管理タグを付与できませんでした: ${message}`,
    });
    return false;
  }
}

function adaptForumThread(thread: PublicThreadChannel<true>): EditableForumThread {
  const forum = thread.parent;
  return {
    id: thread.id,
    appliedTags: thread.appliedTags,
    availableTags: forum?.type === ChannelType.GuildForum ? forum.availableTags : [],
    fetch: async () => adaptForumThread(await thread.fetch(true) as PublicThreadChannel<true>),
    edit: (patch) => thread.edit(patch),
  };
}

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
