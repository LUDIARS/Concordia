/**
 * `/spawn` (委託テンプレート起動) と `/spawn-plain` (provider + model 起動) が共有する Discord 側の手順。
 *
 * - 起動先の決定 (明示の拠点 → project の担当拠点 → 選択 UI → 本社)
 * - Session forum スレッドへの Cc 管理タグ付与
 * - 実行チャンネルからのチーム解決
 * - 子会社の担当プロジェクト判定
 * - 起動後のセッションチャンネル待受
 *
 * どちらのコマンドも起動要求の組み立てだけを持ち、ここは起動の前後の共通部分だけを持つ。
 */
import { ChannelType, type PublicThreadChannel } from "discord.js";
import type { DiscordCommandDeps, DiscordCommandSpec } from "../command-port.js";
import { chooseSpawnTarget, decideSpawnTarget, HQ_SPAWN_TARGET, type SiteSpawnForum, type SpawnResponder } from "./spawn-site.js";
import { resolveTeamFromChannel, type SpawnChannelChain } from "../team-channel-binding.js";
import { markForumThreadAsConcordiaManaged, type EditableForumThread } from "../forum-system-tag.js";
import { checkSubsidiarySpawnTarget, subsidiarySpawnDenialMessage } from "../../subsidiary/spawn-scope.js";

type SpawnInteraction = Parameters<DiscordCommandSpec["execute"]>[0];
type AutocompleteInteraction = Parameters<NonNullable<DiscordCommandSpec["autocomplete"]>>[0];

export type ResolvedSpawnTarget =
  | { kind: "hq"; ix: SpawnResponder }
  | { kind: "site"; ix: SpawnResponder; site: string; via: string }
  | { kind: "cancelled" };

/** 拠点候補の補完。 子会社では本社の拠点を出さない。 */
export async function respondSiteChoices(
  interaction: AutocompleteInteraction,
  deps: DiscordCommandDeps,
  focused: string,
): Promise<void> {
  const sites = deps.subsidiaryId ? [] : deps.spawnSites?.list() ?? [];
  await interaction.respond(sites
    .filter((site) => !focused || site.siteId.toLowerCase().includes(focused) || site.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((site) => ({ name: `${site.name} (${site.siteId})`.slice(0, 100), value: site.siteId })));
}

/**
 * 起動先を決める。 明示の拠点 → project の担当拠点 (1 つなら自動) → 複数なら選択 UI → それ以外は本社
 * (2026-10-07 neco 指示)。 拠点指定は連合が有効な本社 Bot だけ受け付ける。
 */
export async function resolveSpawnTarget(
  interaction: SpawnInteraction,
  deps: DiscordCommandDeps,
  input: { site?: string; project?: string; task?: string },
): Promise<ResolvedSpawnTarget> {
  if (input.site && (deps.subsidiaryId || !deps.spawnSites)) {
    await interaction.reply({ content: "拠点を指定した起動は、連合が有効な本社の Bot でだけ使えます。", ephemeral: true });
    return { kind: "cancelled" };
  }
  const spawnSites = deps.subsidiaryId ? undefined : deps.spawnSites;
  let target = decideSpawnTarget({
    site: input.site,
    project: input.project,
    task: input.task,
    sitesForProject: spawnSites ? (p) => spawnSites.forProject(p) : undefined,
  });
  let ix: SpawnResponder = interaction;
  if (target.kind === "choose") {
    const chosen = await chooseSpawnTarget(interaction, input.project!, target.candidates, deps.log);
    if (!chosen) return { kind: "cancelled" };
    // 選択の interaction は返信の型引数だけが異なる。 以後は共通の返信 API だけを使う。
    ix = chosen.interaction as unknown as SpawnResponder;
    target = chosen.target === HQ_SPAWN_TARGET ? { kind: "hq" } : { kind: "site", site: chosen.target, via: "explicit" };
  }
  if (target.kind === "site" && spawnSites) return { kind: "site", ix, site: target.site, via: target.via };
  return { kind: "hq", ix };
}

/**
 * 子会社の起動先を関係プロジェクトに閉じる (spec/feature/subsidiary-delegation.md §3.4)。
 * 通れば true。 拒否したら返信まで済ませて false を返す。 本社 (subsidiaryId 無し) は常に true。
 */
export async function guardSubsidiarySpawn(
  interaction: SpawnInteraction,
  deps: DiscordCommandDeps,
  input: { project?: string; cwd?: string; task?: string },
): Promise<boolean> {
  if (!deps.subsidiaryId) return true;
  if (!deps.resolveSubsidiaryProjects) {
    // 子会社 id だけ配線されて scope resolver が欠けた構成を、本社相当の無制限にしない。
    deps.log.warn(`spawn command rejected: subsidiary project scope unavailable subsidiary=${deps.subsidiaryId}`);
    await interaction.reply({ content: "この窓口の担当プロジェクト設定を確認できないため起動しません。", ephemeral: true });
    return false;
  }
  const scope = checkSubsidiarySpawnTarget({ project: input.project, cwd: input.cwd, projects: deps.resolveSubsidiaryProjects() });
  if (!scope.ok) {
    deps.log.warn(
      `spawn command rejected (subsidiary scope) subsidiary=${deps.subsidiaryId} ` +
      `denial=${scope.denial} project=${input.project ?? "-"} has_cwd=${input.cwd ? 1 : 0} user=${interaction.user.id}`,
    );
    await interaction.reply({ content: subsidiarySpawnDenialMessage(scope.denial), ephemeral: true });
    return false;
  }
  if (input.task) {
    deps.log.warn(`spawn command rejected (subsidiary task scope unavailable) subsidiary=${deps.subsidiaryId} user=${interaction.user.id}`);
    await interaction.reply({ content: "この窓口では `task` の指定を利用できません。作業内容は `prompt` で指定してください。", ephemeral: true });
    return false;
  }
  return true;
}

/**
 * 実行チャンネルからチームを引く。 Discord 側の階層解決だけをここで行い、
 * 突き合わせ規則は team-channel-binding.ts の純関数に置く。
 * teams 未注入・ギルド外・一致なしはすべて null (チーム未所属)。
 */
export function resolveSpawnChannelTeam(
  interaction: SpawnInteraction,
  deps: DiscordCommandDeps,
): ReturnType<typeof resolveTeamFromChannel> {
  const teams = deps.teams;
  if (!teams) return null;
  const channel = interaction.channel;
  const chain: SpawnChannelChain = channel?.isThread()
    ? { channelId: channel.id, parentId: channel.parentId, categoryId: channel.parent?.parentId ?? null }
    : {
        channelId: interaction.channelId,
        parentId: null,
        categoryId: channel && "parentId" in channel ? channel.parentId ?? null : null,
      };
  return resolveTeamFromChannel(teams, chain);
}

/** チームの明示指定が無ければ、どのチーム面で実行したかから補う (spec/feature/teams.md §2)。 */
export function resolveSpawnTeam(
  interaction: SpawnInteraction,
  deps: DiscordCommandDeps,
  requestedTeam?: string,
): string | undefined {
  if (requestedTeam) return requestedTeam;
  const channelTeam = resolveSpawnChannelTeam(interaction, deps);
  if (channelTeam) {
    deps.log.info(`spawn team resolved from channel team=${channelTeam.teamId} via=${channelTeam.via} channel=${interaction.channelId}`);
  }
  return channelTeam?.teamId;
}

export function effortOptions(provider: string | null, effort: string): Record<string, string> {
  return provider === "claude" ? { effort } : { model_reasoning_effort: effort };
}

/** 拠点とのやり取りに使う Session フォーラム。 forum mode off (フォーラム無し) なら undefined。 */
export function siteSpawnForum(deps: DiscordCommandDeps): SiteSpawnForum | undefined {
  const forumId = deps.layout.forumMode ? deps.layout.sessionForumId : "";
  if (!forumId) return undefined;
  return {
    forumId,
    async openPost({ title, content }) {
      const forum = await deps.guild.channels.fetch(forumId);
      if (!forum || forum.type !== ChannelType.GuildForum) throw new Error("Session forum not found");
      return forum.threads.create({ name: title, message: { content, allowedMentions: { parse: [] } } });
    },
  };
}

/** Session forum のスレッドで実行されたら Cc 管理タグを付ける。 付けられなければ起動しない (false)。 */
export async function markExplicitSpawnThread(interaction: SpawnResponder, deps: DiscordCommandDeps): Promise<boolean> {
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
    await interaction.editReply({ content: `spawn failed: Forum の Cc 管理タグを付与できませんでした: ${message}` });
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

/** スポーン前のアクティブセッション ID。 起動後に新しいセッションチャンネルを見分けるために使う。 */
export function knownSessionIds(deps: DiscordCommandDeps): Set<string> {
  return new Set(deps.sessionChannelsRepo.listActive().map((r) => r.session_id));
}

/**
 * スポーン後、新しいセッションチャンネルが DB に現れるまで最大 12s ポーリングし、
 * Discord チャンネルメンション文字列 (`<#channelId>`) を返す。見つからなければ null。
 */
export async function waitForSessionChannel(
  sessionChannelsRepo: DiscordCommandDeps["sessionChannelsRepo"],
  knownIds: Set<string>,
  timeoutMs = 12000,
  intervalMs = 800,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    for (const row of sessionChannelsRepo.listActive()) {
      if (!knownIds.has(row.session_id) && row.channel_id) return `<#${row.channel_id}>`;
    }
  }
  return null;
}
