/**
 * チーム管理チャンネルの操作面 (チーム一覧 + 一時停止 / 再開)。
 *
 * 2026-08-27 neco 指示: 「作業していないチームは一時的に止められるようにする」+
 * 「チーム管理用のチャンネルを用意」。 一時停止中のチームは定時 fanout (朝礼 / 定例 /
 * issue scout / タスク整理) の対象から外れる (scheduler/cron-fanout.ts)。 アーカイブでは
 * ないので、 手動 spawn・チーム面・設定はそのまま生きる。
 *
 * このファイルは customId の組み立て / 解釈と描画 (interaction-ui の PanelSpec) と
 * ボタン処理を持つ。 チャンネル上のパネルは 1 メッセージ更新型 (pr-queue-channel と
 * 同パターン)。 パネルの再描画は team.changed イベント経由で bot.ts が行う。
 *
 * @implements spec/feature/teams.md §4.5
 */

import { randomUUID } from "node:crypto";
import type { ButtonInteraction, Interaction, TextChannel } from "discord.js";
import type { TeamRow, TeamsRepo } from "../db/teams-repo.js";
import { eventBus } from "../events.js";
import { buildPanel, type PanelButton, type RenderedPanel } from "./interaction-ui.js";

/** customId の名前空間。 既存の `ctrl:` / `test:` とは別に切る。 */
const PREFIX = "teamadm";

const PANEL_MESSAGE_KEY = "team_admin_panel_message_id";

export type TeamAdminAction = "suspend" | "resume";

export function buildTeamAdminControlId(action: TeamAdminAction, teamId: string): string {
  return `${PREFIX}:${action}:${teamId}`;
}

export function parseTeamAdminControlId(
  customId: string,
): { action: TeamAdminAction; teamId: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const action = parts[1];
  if (action !== "suspend" && action !== "resume") return null;
  // team id は自前で発行した `team_<hex>` だけを認める (teams-repo.create の書式)。
  if (!/^team_[0-9a-f]{32}$/.test(parts[2])) return null;
  return { action, teamId: parts[2] };
}

/** この interaction がチーム管理パネル由来か (dispatcher の分岐用)。 */
export function isTeamAdminInteraction(interaction: Interaction): boolean {
  return interaction.isButton() && parseTeamAdminControlId(interaction.customId) !== null;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * チーム一覧パネル。 1 チーム 1 行 + 1 ボタン (稼働中→一時停止 / 停止中→再開)。
 * ボタン上限 (5 行 × 5 個) を超えた分は buildPanel が footer に明記して省略する。
 */
export function buildTeamAdminPanel(teams: readonly TeamRow[]): RenderedPanel {
  const lines = teams.map((team) => {
    const label = `**${team.name}** (\`${team.slug}\`)`;
    return team.suspended_at !== null
      ? `⏸ ${label} — 一時停止中 (定時ジョブ対象外)`
      : `🟢 ${label}`;
  });
  const buttons: PanelButton[] = teams.map((team) => (
    team.suspended_at !== null
      ? {
        customId: buildTeamAdminControlId("resume", team.id),
        label: clip(`▶ 再開: ${team.name}`, 80),
        style: "success" as const,
      }
      : {
        customId: buildTeamAdminControlId("suspend", team.id),
        label: clip(`⏸ 一時停止: ${team.name}`, 80),
        style: "secondary" as const,
      }
  ));
  return buildPanel({
    title: "チーム管理",
    description: teams.length > 0
      ? lines.join("\n")
      : "チームはまだ登録されていません。",
    footer: "一時停止中は朝礼・定例・issue scout・タスク整理の定時ジョブが止まります (手動 spawn は可)",
    tone: "info",
    buttons,
  });
}

/**
 * チーム管理チャンネルのパネルを 1 メッセージ更新で維持する (pr-queue と同パターン)。
 * メッセージが消えていたら作り直して id を差し替える。
 */
export async function upsertTeamAdminPanelMessage(
  channel: TextChannel,
  panel: RenderedPanel,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
): Promise<void> {
  const msgId = configGet(PANEL_MESSAGE_KEY);
  try {
    if (msgId) {
      const msg = await channel.messages.fetch(msgId);
      await msg.edit({ embeds: panel.embeds, components: panel.components });
      return;
    }
  } catch {
    // fall through and recreate
  }
  const sent = await channel.send({ embeds: panel.embeds, components: panel.components });
  configSet(PANEL_MESSAGE_KEY, sent.id);
}

export interface TeamAdminInteractionDeps {
  teams: TeamsRepo;
  /**
   * 一時停止 / 再開の権限 (`session_end` capability = 管理職以上)。 セッションを
   * 止められる役職がチームの定時ジョブも止められる、 という対応。 未注入は deny
   * (fail-closed)。
   */
  isSuspendUserAllowed?: (userId: string) => boolean;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

/**
 * 一時停止 / 再開ボタンの処理。 状態変更後は `team.changed` を emit し、 パネルの
 * 再描画はそのイベントを受けた bot.ts 側が行う (処理と描画を二重にしない)。
 */
export async function handleTeamAdminInteraction(
  interaction: ButtonInteraction,
  deps: TeamAdminInteractionDeps,
): Promise<void> {
  const control = parseTeamAdminControlId(interaction.customId);
  if (!control) return;
  const userId = interaction.user.id;
  if (deps.isSuspendUserAllowed?.(userId) !== true) {
    deps.log.warn(`team-admin: ${control.action} denied team=${control.teamId}`);
    await interaction.reply({
      content: "チームの一時停止 / 再開には社員名簿の session_end 権限 (管理職以上) が必要です。",
      ephemeral: true,
    });
    return;
  }
  const before = deps.teams.find(control.teamId);
  if (!before) {
    await interaction.reply({ content: "このチームは既に存在しません。", ephemeral: true });
    return;
  }
  const suspend = control.action === "suspend";
  const changed = (before.suspended_at !== null) !== suspend;
  const row = deps.teams.setSuspended(control.teamId, suspend)!;
  if (changed) {
    eventBus.emit({
      type: "team.changed",
      event_id: randomUUID(),
      team_id: row.id,
      fields: ["suspended_at"],
      ts: Math.floor(Date.now() / 1000),
    });
  }
  deps.log.info(
    `team-admin: ${control.action} team=${row.id} (${row.slug}) changed=${changed}`,
  );
  await interaction.reply({
    content: suspend
      ? `⏸ **${row.name}** を一時停止しました。定時ジョブ (朝礼・定例・issue scout・タスク整理) の対象から外れます。`
      : `▶ **${row.name}** を再開しました。定時ジョブの対象に戻ります。`,
    ephemeral: true,
  });
}
