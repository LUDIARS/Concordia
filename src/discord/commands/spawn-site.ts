/**
 * `/spawn site:` — 起動先の拠点を指定して、その拠点の Cc にセッションを起動させる
 * (2026-10-07 neco 指示「spawnコマンドにspawnする拠点を設定できるように」)。
 *
 * 拠点は Bot トークンを持たないので、 拠点のセッションの発言と人の返信はスレッドで中継する
 * (spec/feature/federation-link.md §本社からのセッション起動)。 スレッド内で実行したらそのスレッド、
 * それ以外は受付返信からスレッドを作る。 本社では起動しない。
 */
import { ActionRowBuilder, ComponentType, StringSelectMenuBuilder, type MessageComponentInteraction } from "discord.js";
import type { DiscordCommandSpec, SpawnSitePort } from "../command-port.js";
import type { RemoteSpawnOptions } from "../../federation/remote-session-payload.js";

/**
 * `/spawn` の返信先。 通常はスラッシュコマンド、 起動先を選んだ後はその選択の interaction。
 * 両者が共通に持つ返信・チャンネル情報だけを使う。
 */
export type SpawnResponder = Pick<Parameters<DiscordCommandSpec["execute"]>[0],
  "reply" | "deferReply" | "editReply" | "fetchReply" | "channel" | "channelId" | "guildId" | "user">;

/** 選択画面で「本社で起動」を表す値 (拠点 ID の規則 [a-z0-9-] と重ならない)。 */
export const HQ_SPAWN_TARGET = "__hq__";
const TARGET_CHOICE_TIMEOUT_MS = 120_000;

/** 起動先の決め方 (2026-10-07 neco 指示: タグ / プロジェクトの担当拠点で自動 / 決まらなければ選択 UI)。 */
export type SpawnTargetDecision =
  | { kind: "hq" }
  | { kind: "site"; site: string; via: "explicit" | "project" }
  | { kind: "choose"; candidates: Array<{ siteId: string; name: string }> };

export function decideSpawnTarget(input: {
  site?: string;
  project?: string;
  task?: string;
  sitesForProject?: (project: string) => Array<{ siteId: string; name: string }>;
}): SpawnTargetDecision {
  if (input.site) return { kind: "site", site: input.site, via: "explicit" };
  // Memoria task の完了連携は本社でしか持たないので、 task 付きは自動で拠点へ渡さない。
  if (!input.project || input.task || !input.sitesForProject) return { kind: "hq" };
  const candidates = input.sitesForProject(input.project);
  if (candidates.length === 0) return { kind: "hq" };
  if (candidates.length === 1) return { kind: "site", site: candidates[0]!.siteId, via: "project" };
  return { kind: "choose", candidates };
}

/** 起動先の選択肢 (担当拠点 + 本社)。 */
export function spawnTargetMenu(customId: string, project: string, candidates: Array<{ siteId: string; name: string }>) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("起動先を選んでください")
    .addOptions(
      ...candidates.slice(0, 24).map((site) => ({ label: site.name.slice(0, 100), value: site.siteId, description: `拠点 ${site.siteId}`.slice(0, 100) })),
      { label: "本社", value: HQ_SPAWN_TARGET, description: "本社の Cc で起動する" },
    );
  return {
    content: `\`${project}\` は複数の拠点が担当しています。起動先を選んでください。`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  };
}

/**
 * 起動先を選んでもらう。 選ばれたらその選択の interaction (以後の返信先) と起動先を返す。
 * 時間切れ・別の人の操作では起動しない。
 */
export async function chooseSpawnTarget(
  interaction: Parameters<DiscordCommandSpec["execute"]>[0],
  project: string,
  candidates: Array<{ siteId: string; name: string }>,
  log: { info(message: string): void; warn(message: string): void },
): Promise<{ interaction: MessageComponentInteraction; target: string } | null> {
  const customId = `spawn-target:${interaction.id}`;
  const prompt = await interaction.reply({ ...spawnTargetMenu(customId, project, candidates), ephemeral: true, fetchReply: true });
  try {
    const component = await prompt.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      filter: (candidate) => candidate.customId === customId && candidate.user.id === interaction.user.id,
      time: TARGET_CHOICE_TIMEOUT_MS,
    });
    const target = component.values[0] ?? HQ_SPAWN_TARGET;
    const label = target === HQ_SPAWN_TARGET ? "本社" : candidates.find((site) => site.siteId === target)?.name ?? target;
    await interaction.editReply({ content: `起動先: ${label}`, components: [] });
    log.info(`spawn command target chosen project=${project} target=${target}`);
    return { interaction: component, target };
  } catch {
    log.info(`spawn command target choice timed out project=${project}`);
    await interaction.editReply({ content: "起動先が選ばれなかったため、起動しませんでした。", components: [] }).catch(() => undefined);
    return null;
  }
}

export interface SiteSpawnFields {
  provider?: "claude" | "codex" | "gemini";
  template?: string;
  inject: boolean;
  prompt?: string;
  model?: string;
  effort?: string;
  project?: string;
  branch?: string;
  cwd?: string;
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const THREAD_NAME_MAX = 90;

/** 拠点へ渡す題名・本文・起動条件。 題名は prompt の 1 行目、 無ければ起動条件から作る。 */
export function buildSiteSpawnRequest(fields: SiteSpawnFields): { title: string; body: string; options: RemoteSpawnOptions } {
  const firstLine = fields.prompt?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  const title = firstLine ?? ([fields.template ?? fields.provider, fields.project ?? fields.cwd].filter(Boolean).join(" ") || "spawn");
  const options: RemoteSpawnOptions = {
    ...(fields.provider ? { provider: fields.provider } : {}),
    ...(fields.template ? { template: fields.template, inject_prompt: fields.inject } : {}),
    ...(fields.model ? { model: fields.model } : {}),
    ...(fields.effort && EFFORTS.has(fields.effort) ? { effort: fields.effort as NonNullable<RemoteSpawnOptions["effort"]> } : {}),
    ...(fields.project ? { project: fields.project } : {}),
    ...(fields.branch ? { branch: fields.branch } : {}),
    ...(fields.cwd ? { cwd: fields.cwd } : {}),
  };
  return { title, body: fields.prompt ?? "", options };
}

/** 起動条件の不足。 拠点にはチームの概念を渡せないので、 provider 起動は project / cwd を要求する。 */
export function siteSpawnInputError(fields: SiteSpawnFields): string | null {
  if (!fields.provider && !fields.template) return "provider か template のどちらかを指定してください。";
  if (!fields.template && !fields.project && !fields.cwd) {
    return "拠点で起動するときは、作業対象の `project` か `cwd` を指定してください (team は拠点へ渡せません)。";
  }
  return null;
}

export function siteSpawnFailureMessage(reason: "unknown_site" | "inactive_site" | "ambiguous_site" | "listener_unavailable"): string {
  switch (reason) {
    case "unknown_site": return "指定した拠点が見つかりません。拠点 ID か表示名を指定してください。";
    case "inactive_site": return "指定した拠点は失効しています。";
    case "ambiguous_site": return "同じ名前の拠点が複数あります。拠点 ID で指定してください。";
    case "listener_unavailable": return "本社の連合 listener が停止しているため、拠点へ起動を渡せません。";
  }
}

/** Discord 側の手順: スレッドを用意して拠点へ渡し、 結果を受付返信に書く。 */
export async function executeSiteSpawn(
  interaction: SpawnResponder,
  port: SpawnSitePort,
  site: string,
  fields: SiteSpawnFields,
  log: { info(message: string): void; warn(message: string): void },
): Promise<void> {
  const inputError = siteSpawnInputError(fields);
  if (inputError) {
    await interaction.reply({ content: inputError, ephemeral: true });
    return;
  }
  if (!interaction.guildId) {
    await interaction.reply({ content: "拠点での起動はサーバー内でだけ使えます。", ephemeral: true });
    return;
  }
  const request = buildSiteSpawnRequest(fields);
  await interaction.deferReply({ ephemeral: false });
  let channelId = interaction.channelId;
  if (!interaction.channel?.isThread()) {
    // 拠点の発言と返信をこのチャンネルに流さないよう、 受付返信からスレッドを作る。
    await interaction.editReply({ content: `拠点「${site}」での起動を準備しています…` });
    const reply = await interaction.fetchReply();
    const thread = await reply.startThread({ name: Array.from(request.title).slice(0, THREAD_NAME_MAX).join("") });
    channelId = thread.id;
  }
  const routed = port.route({
    site, guildId: interaction.guildId, channelId, authorId: interaction.user.id,
    title: request.title, body: request.body, options: request.options,
  });
  if (!routed.ok) {
    log.warn(`spawn command site route failed site=${site} reason=${routed.reason} channel=${channelId}`);
    await interaction.editReply({ content: `spawn failed: ${siteSpawnFailureMessage(routed.reason)}` });
    return;
  }
  log.info(`spawn command routed to site site=${routed.siteId} channel=${channelId}`);
  await interaction.editReply({
    content: `拠点「${routed.siteName}」の Cc にセッションの起動を依頼しました。起動結果と発言は <#${channelId}> に届き、そこへの返信は拠点のセッションに届きます。`,
  });
}
