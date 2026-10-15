/**
 * /patrol — 子会社サーバーの管理者が、 その子会社の巡回チャットを自分で設定する
 * (spec/plan/2026-10-15-patrol-subsidiary-rules-design.md §3)。
 *
 * - 子会社 guild にだけ登録する (subsidiary-scope.ts の SUBSIDIARY_ONLY)。 本社は Web の /rules。
 * - 実行できるのはその guild の「サーバー管理」(Manage Guild) 権限を持つ人だけ。 本社の役職とは切り離す。
 *   default_member_permissions と実行時の memberPermissions の二段で見る。
 * - 対象はこの Bot の子会社 (deps.subsidiaryId) の rule だけ。 本社の /v1/subsidiaries/:id/patrol/* を呼ぶ。
 * - 応答は本人にだけ (ephemeral)。 変更者は discord:<user id> として版と rule_log に残る。
 */

import { PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { DiscordCommandDeps, DiscordCommandSpec } from "../command-port.js";
import {
  channelIdOf,
  formatDefaults,
  formatRule,
  mergeDefaults,
  parseQuietArg,
  type PatrolDefaultsView,
  type PatrolRuleView,
} from "../patrol-command-args.js";

const builder = new SlashCommandBuilder()
  .setName("patrol")
  .setDescription("このサーバーの巡回チャット (トレンドの一言) を設定する (サーバー管理者のみ)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((s) => s.setName("list").setDescription("巡回ルールの一覧"))
  .addSubcommand((s) => s.setName("add").setDescription("トレンド巡回を 1 本追加する (このチャンネルか指定チャンネルへ投稿)")
    .addChannelOption((o) => o.setName("channel").setDescription("投稿先 (省略時はこのチャンネル)"))
    .addIntegerOption((o) => o.setName("interval_min").setDescription("投稿の間隔 (分、10〜1440)").setMinValue(10).setMaxValue(1440)))
  .addSubcommand((s) => s.setName("set").setDescription("巡回ルールを変更する")
    .addStringOption((o) => o.setName("rule").setDescription("ルール ID (list で確認)").setRequired(true))
    .addIntegerOption((o) => o.setName("interval_min").setDescription("投稿の間隔 (分、10〜1440)").setMinValue(10).setMaxValue(1440))
    .addIntegerOption((o) => o.setName("daily_limit").setDescription("1日の投稿上限 (1〜48)").setMinValue(1).setMaxValue(48))
    .addStringOption((o) => o.setName("quiet").setDescription("新規投稿しない時間帯「22:00-09:30」/「なし」/「既定」"))
    .addChannelOption((o) => o.setName("channel").setDescription("投稿先"))
    .addStringOption((o) => o.setName("persona").setDescription("名前の雰囲気 (例: 学校らしく) /「既定」"))
    .addStringOption((o) => o.setName("instructions").setDescription("投稿の方針 (短文生成への指示)")))
  .addSubcommand((s) => s.setName("on").setDescription("巡回ルールを動かす")
    .addStringOption((o) => o.setName("rule").setDescription("ルール ID").setRequired(true)))
  .addSubcommand((s) => s.setName("off").setDescription("巡回ルールを止める")
    .addStringOption((o) => o.setName("rule").setDescription("ルール ID").setRequired(true)))
  .addSubcommand((s) => s.setName("defaults").setDescription("このサーバーの既定値を見る"))
  .addSubcommand((s) => s.setName("defaults-set").setDescription("このサーバーの既定値を変える (ルール側で指定が無い項目に効く)")
    .addStringOption((o) => o.setName("quiet").setDescription("新規投稿しない時間帯「22:00-09:30」/「なし」/「既定」"))
    .addIntegerOption((o) => o.setName("daily_limit").setDescription("1日の投稿上限 (1〜48)").setMinValue(1).setMaxValue(48))
    .addChannelOption((o) => o.setName("channel").setDescription("投稿先"))
    .addStringOption((o) => o.setName("persona").setDescription("名前の雰囲気 /「既定」"))
    .addBooleanOption((o) => o.setName("paused").setDescription("このサーバーの巡回をまるごと止める")));

interface CallResult { ok: boolean; status: number; body: Record<string, unknown> }

async function call(deps: DiscordCommandDeps, method: string, path: string, body?: unknown): Promise<CallResult> {
  const res = await fetch(`${deps.concordiaUrl}/v1/subsidiaries/${encodeURIComponent(deps.subsidiaryId!)}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body: json };
}

function failure(r: CallResult): string {
  if (r.status === 404) return "そのルールはこのサーバーのものではないか、 見つかりません。 `/patrol list` で確認してください。";
  const reason = typeof r.body.reason === "string" ? r.body.reason : typeof r.body.error === "string" ? r.body.error : `HTTP ${r.status}`;
  return `変更できませんでした: ${reason}`;
}

async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.editReply({ content: content.slice(0, 1900), allowedMentions: { parse: [] } });
}

const patrolCommand: DiscordCommandSpec = {
  builder,
  async execute(interaction, deps) {
    if (!deps.subsidiaryId) {
      await interaction.reply({ content: "このコマンドは子会社のサーバーでだけ使えます (本社は Web の「ルール」画面)。", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "巡回チャットの設定は、 このサーバーの「サーバー管理」権限を持つ人だけができます。", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const actor = `discord:${interaction.user.id}`;
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === "list") {
        const r = await call(deps, "GET", "/patrol/rules");
        if (!r.ok) return reply(interaction, failure(r));
        const rules = (r.body.rules as PatrolRuleView[]) ?? [];
        return reply(interaction, rules.length ? rules.map(formatRule).join("\n\n") : "巡回ルールはまだありません。 `/patrol add` で追加できます。");
      }
      if (sub === "add") {
        const channelId = interaction.options.getChannel("channel")?.id ?? interaction.channelId;
        const minutes = interaction.options.getInteger("interval_min");
        const r = await call(deps, "POST", "/patrol/rules", {
          actor, discord_channel_id: channelId, ...(minutes ? { tick_sec: minutes * 60 } : {}),
        });
        if (!r.ok) return reply(interaction, failure(r));
        return reply(interaction, `追加しました (最初の投稿は間隔の中で少しずらして始まります)。\n\n${formatRule(r.body.rule as PatrolRuleView)}`);
      }
      if (sub === "set") {
        const patch: Record<string, unknown> = { actor };
        const minutes = interaction.options.getInteger("interval_min");
        if (minutes) patch.tick_sec = minutes * 60;
        const limit = interaction.options.getInteger("daily_limit");
        if (limit) patch.root_limit_per_day = limit;
        const quiet = interaction.options.getString("quiet");
        if (quiet !== null) {
          const q = parseQuietArg(quiet);
          if (q && typeof q === "object" && "error" in q) return reply(interaction, q.error);
          patch.quiet_hours = q;
        }
        const channel = interaction.options.getChannel("channel")?.id;
        if (channel) patch.discord_channel_id = channelIdOf(channel);
        const persona = interaction.options.getString("persona");
        if (persona !== null) patch.persona_hint = persona.trim() === "既定" ? null : persona.trim().slice(0, 80);
        const instructions = interaction.options.getString("instructions");
        if (instructions !== null) patch.instructions = instructions.trim().slice(0, 400);
        if (Object.keys(patch).length === 1) return reply(interaction, "変更する項目を 1 つ以上指定してください。");
        const rule = interaction.options.getString("rule", true);
        const r = await call(deps, "PATCH", `/patrol/rules/${encodeURIComponent(rule)}`, patch);
        if (!r.ok) return reply(interaction, failure(r));
        return reply(interaction, `変更しました。\n\n${formatRule(r.body.rule as PatrolRuleView)}`);
      }
      if (sub === "on" || sub === "off") {
        const rule = interaction.options.getString("rule", true);
        const r = await call(deps, "POST", `/patrol/rules/${encodeURIComponent(rule)}/toggle`, { actor, enabled: sub === "on" });
        if (!r.ok) return reply(interaction, failure(r));
        return reply(interaction, `${sub === "on" ? "動かしました" : "止めました"}。\n\n${formatRule(r.body.rule as PatrolRuleView)}`);
      }
      if (sub === "defaults" || sub === "defaults-set") {
        const cur = await call(deps, "GET", "/patrol-defaults");
        if (!cur.ok) return reply(interaction, failure(cur));
        const view = cur.body as unknown as PatrolDefaultsView;
        if (sub === "defaults") return reply(interaction, formatDefaults(view));
        const quiet = interaction.options.getString("quiet");
        let quietArg: ReturnType<typeof parseQuietArg> | undefined;
        if (quiet !== null) {
          quietArg = parseQuietArg(quiet);
          if (quietArg && typeof quietArg === "object" && "error" in quietArg) return reply(interaction, quietArg.error);
        }
        const next = mergeDefaults(view.defaults ?? {}, {
          ...(quietArg !== undefined ? { quiet: quietArg as Exclude<typeof quietArg, { error: string }> } : {}),
          rootLimit: interaction.options.getInteger("daily_limit"),
          channelId: interaction.options.getChannel("channel")?.id ?? null,
          persona: interaction.options.getString("persona"),
          paused: interaction.options.getBoolean("paused"),
        });
        const r = await call(deps, "PUT", "/patrol-defaults", { actor, defaults: next });
        if (!r.ok) return reply(interaction, failure(r));
        return reply(interaction, `既定値を変えました。\n\n${formatDefaults({ defaults: next, updated_by: actor })}`);
      }
      return reply(interaction, "不明なサブコマンドです。");
    } catch (err) {
      deps.log.warn(`/patrol failed subsidiary=${deps.subsidiaryId} sub=${sub}: ${(err as Error).message}`);
      return reply(interaction, "Concordia に接続できませんでした。 しばらくしてからもう一度試してください。");
    }
  },
};

export default patrolCommand;
