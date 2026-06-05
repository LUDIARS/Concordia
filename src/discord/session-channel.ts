// session.registered / lost / ended に応じて Discord channel を CRUD する.
//
// レイアウト方針 (2026-05-29 〜):
//   - 「sessions」 カテゴリ = active/lost セッションの会話 channel
//   - 「状態」 カテゴリ = cost + status-card (状態ボード) のみ。 セッション会話
//     channel は置かない (= 状態ボードがセッション channel で溢れるのを防ぐ)
//   - 「閉じた」 (ended) セッションは channel を **archive カテゴリへ移動** + ⚪ prefix
//     (削除しない。 会話ログを残す。 2026-06-01 にユーザ指示で「削除→アーカイブ」 へ変更)
//
// 旧方針 (2026-05-28) は session channel も状態カテゴリに作っていたが、 状態ボード
// にセッション channel が混ざる問題があったため sessions カテゴリへ戻した.
//
// 5min cooldown (実測値は 5-10 分。 Discord API は 2 rename / 10min と公称) を
// DB の last_rename_ts で守る. cooldown 内の rename は skip され、 次回 event
// で再試行される. 短期 idle↔active 振動は emoji 変更しない (= rename しない).

import type { Guild } from "discord.js";
import { ChannelType } from "discord.js";
import type { DiscordConfigSnapshot } from "./config.js";
import type {
  DiscordConfigRepo,
  DiscordSessionChannelsRepo,
  DiscordSessionStatus,
} from "../db/discord-repo.js";
import {
  applyStatusEmoji,
  buildSessionChannelName,
  extractDisplayState,
  roleSlug,
} from "./formatter.js";
import type { WebhookPool } from "./webhook-pool.js";

/** session-status-card.ts と key を揃える (循環 import 回避のためここで再定義). */
const STATUS_CARD_CHANNEL_KEY_PREFIX = "session_status_channel_id:";

const RENAME_COOLDOWN_SEC = 5 * 60;

export interface SessionChannelDeps {
  guild: Guild;
  layout: DiscordConfigSnapshot;
  repo: DiscordSessionChannelsRepo;
  log: { info: (m: string) => void; warn: (m: string) => void };
  /** ended → archive 時に当該 channel の webhook を解放するため (任意)。 */
  webhooks?: WebhookPool;
}

/** session.registered → channel 作成 + 🟢 prefix + active マーク. */
export async function onSessionRegistered(
  deps: SessionChannelDeps,
  input: { sessionId: string; agentType: string | null; roleLabel: string | null; personaDisplayName: string | null },
): Promise<void> {
  const existing = deps.repo.findBySessionId(input.sessionId);
  if (existing) return; // 既知 (再 register など)

  // 名前 = 🟢<エージェント絵文字>-<role>。作業内容は title_renamed で後から body に載る。
  const name = buildSessionChannelName("active", input.agentType, roleSlug(input.roleLabel ?? "anon"));
  try {
    const created = await deps.guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: deps.layout.sessionsCategoryId,
      topic: input.personaDisplayName
        ? `${input.personaDisplayName} — session ${input.sessionId}`
        : `session ${input.sessionId}`,
    });
    deps.repo.upsert({
      session_id: input.sessionId,
      channel_id: created.id,
      status: "active",
    });
    deps.log.info(`session-channel: created #${created.name} for ${input.sessionId}`);

    // セッション spawn (= channel 作成) と同時に webhook も eager 作成し token を
    // 永続化する。 これで以降の egress は getForSession の DB-token パスに直行し、
    // 初回 egress 時の遅延作成 (= cache miss 並行到来による thundering-herd 対策の
    // in-flight / 既存再利用ロジック。 バグの温床) を実質踏まなくなる。 ここで
    // 失敗しても getForSession 側の遅延作成が fallback として残るので best-effort。
    if (deps.webhooks) {
      const wh = await deps.webhooks.getForSession(input.sessionId);
      deps.log.info(
        wh
          ? `session-channel: webhook ready (eager) for ${input.sessionId}`
          : `session-channel: eager webhook create failed for ${input.sessionId} (will retry lazily)`,
      );
    }
  } catch (e) {
    deps.log.warn(`session-channel: create failed for ${input.sessionId}: ${(e as Error).message}`);
  }
}

/**
 * session.lost / session.ended に応じた channel 操作.
 *  - ended → channel を archive カテゴリへ移動 + ⚪ prefix (削除しない、 会話ログ保全)
 *  - lost  → emoji だけ更新 (状態カテゴリに留める)
 *  - active への復帰 → emoji 更新 (状態カテゴリにいる前提)
 */
export async function onSessionStatusChanged(
  deps: SessionChannelDeps,
  input: { sessionId: string; status: DiscordSessionStatus },
): Promise<void> {
  const row = deps.repo.findBySessionId(input.sessionId);
  if (!row) return;
  if (row.status === input.status) return;

  // ended は archive カテゴリへ移動 (削除しない / rename cooldown を経由しない).
  // DB row は status=ended で残す — 会話チャンネルと対応を保持し続ける.
  if (input.status === "ended") {
    deps.repo.setStatus(input.sessionId, "ended");
    const ch = deps.guild.channels.cache.get(row.channel_id);
    if (ch && ch.type === ChannelType.GuildText) {
      try {
        const endedName = applyStatusEmoji(ch.name, "ended");
        await ch.edit({
          name: endedName,
          parent: deps.layout.archiveCategoryId,
          reason: `session ${input.sessionId} ended → archive`,
        });
        deps.log.info(
          `session-channel: archived #${endedName} (${row.channel_id}) for ended ${input.sessionId}`,
        );
      } catch (e) {
        // 失敗しても channel は消えない (sessions カテゴリに残るだけ). best-effort.
        deps.log.warn(
          `session-channel: archive move failed for ${input.sessionId}: ${(e as Error).message}`,
        );
      }
    }
    // archived channel が webhook budget (1 channel 15 個) を握り続けないよう、
    // ended 時に当該 channel の bot webhook を解放し DB の token も消す。best-effort.
    if (deps.webhooks) {
      try {
        const purged = await deps.webhooks.purgeChannel(row.channel_id);
        deps.repo.clearWebhook(input.sessionId);
        if (purged > 0) {
          deps.log.info(`session-channel: purged ${purged} webhook(s) on archived channel ${row.channel_id}`);
        }
      } catch (e) {
        deps.log.warn(`session-channel: webhook purge failed for ${input.sessionId}: ${(e as Error).message}`);
      }
    }
    return;
  }

  // それ以外 (active <-> lost) は emoji rename のみ. sessions カテゴリに留める.
  deps.repo.setStatus(input.sessionId, input.status);

  // rename rate limit guard
  if (!deps.repo.tryClaimRename(input.sessionId, RENAME_COOLDOWN_SEC)) {
    deps.log.info(
      `session-channel: rename deferred for ${input.sessionId} (cooldown < ${RENAME_COOLDOWN_SEC}s)`,
    );
    return;
  }

  const ch = deps.guild.channels.cache.get(row.channel_id);
  if (!ch || ch.type !== ChannelType.GuildText) {
    deps.log.warn(`session-channel: channel ${row.channel_id} not found`);
    return;
  }

  const newName = applyStatusEmoji(ch.name, input.status);

  try {
    // sessions カテゴリに無い channel (旧レイアウトで状態カテゴリに作られた遺物
    // 含む) はついでに sessions カテゴリへ移動する
    const patch: { name: string; parent?: string; reason: string } = {
      name: newName,
      reason: `session ${input.sessionId} → ${input.status}`,
    };
    if (ch.parentId !== deps.layout.sessionsCategoryId) {
      patch.parent = deps.layout.sessionsCategoryId;
    }
    await ch.edit(patch);
    deps.log.info(`session-channel: ${input.sessionId} renamed to #${newName}`);
  } catch (e) {
    deps.log.warn(`session-channel: rename failed for ${input.sessionId}: ${(e as Error).message}`);
  }
}

/**
 * 状態カテゴリの整理: cost + status-card channel 以外を削除する.
 * (2026-05-29 〜 session 会話 channel は sessions カテゴリに移したため、 状態
 *  カテゴリに正規に残るのは cost と status-card のみ。 旧レイアウトで状態カテゴリ
 *  に作られた session channel は session_channels テーブルに載っているので
 *  knownChannelIds 経由で削除対象から除外され、 次の status 変化時に
 *  onSessionStatusChanged が sessions カテゴリへ移動する。)
 *
 * status-card channel (\`session-status-card.ts\` が `session_status_channel_id:*`
 * key で configRepo に持つ \`<base>-status\` channel) は、 session_channels テーブル
 * には載っていないので、 configRepo を見て known set に追加する。
 * これを忘れると起動時 boot sweep が **稼働中** の status-card channel を消し、
 * 直後の \`upsertSessionStatusCard\` が Unknown Channel で死ぬ (2026-05-28 実害)。
 *
 * sweeper から定期実行する想定. 過去レイアウトの sessions / archive カテゴリの
 * channel は触らない (新規は state にしか生成しない).
 */
export async function pruneStatusCategoryChannels(
  deps: SessionChannelDeps & { configRepo: DiscordConfigRepo },
): Promise<{
  scanned: number;
  deleted: number;
}> {
  await deps.guild.channels.fetch().catch(() => null);
  const allChannels = deps.guild.channels.cache.filter(
    (c) => c.parentId === deps.layout.statusCategoryId,
  );
  const knownChannelIds = new Set<string>(
    deps.repo.listAll().map((r) => r.channel_id),
  );
  knownChannelIds.add(deps.layout.costChannelId);
  // 運用チャンネルは sweep 削除対象から除外する。
  knownChannelIds.add(deps.layout.activityChannelId);
  knownChannelIds.add(deps.layout.monitorChannelId);
  knownChannelIds.add(deps.layout.prQueueChannelId);
  // status-card channel は configRepo に保存されている (session_status_channel_id:*).
  for (const [key, value] of Object.entries(deps.configRepo.all())) {
    if (!key.startsWith(STATUS_CARD_CHANNEL_KEY_PREFIX)) continue;
    if (value) knownChannelIds.add(value);
  }
  let deleted = 0;
  for (const ch of allChannels.values()) {
    if (knownChannelIds.has(ch.id)) continue;
    try {
      await ch.delete("status-category sweep (orphan)");
      deleted += 1;
      deps.log.info(`session-channel: pruned orphan #${ch.name} (${ch.id}) from status category`);
    } catch (e) {
      deps.log.warn(
        `session-channel: prune failed for ${ch.id}: ${(e as Error).message}`,
      );
    }
  }
  return { scanned: allChannels.size, deleted };
}

/**
 * /rename や current_task で決まったタイトル (= 作業内容) を Discord channel 名 + topic に反映。
 * 名前 = `<現在の状態絵文字><エージェント絵文字>-<作業内容>`。状態絵文字 (作業中⚙️ / 緑🟢 等) は
 * 既存名から引き継ぎ、エージェント絵文字 + body だけ更新する。`[]` は body から除去される。
 */
export async function onSessionTitleChanged(
  deps: SessionChannelDeps,
  input: { sessionId: string; title: string; agentType: string | null },
): Promise<void> {
  const row = deps.repo.findBySessionId(input.sessionId);
  if (!row) return;
  const ch = deps.guild.channels.cache.get(row.channel_id);
  if (!ch || ch.type !== ChannelType.GuildText) return;
  try {
    // status が ended/lost ならその状態を優先、active なら現在の表示状態 (作業中含む) を維持。
    const state = row.status === "active" ? extractDisplayState(ch.name) : row.status;
    const nextName = buildSessionChannelName(state, input.agentType, titleToChannelBase(input.title));
    const patch: { topic: string; reason: string; name: string } = {
      topic: `${input.title.slice(0, 120)} | session ${input.sessionId}`,
      reason: `session title updated: ${input.sessionId}`,
      // title rename は常に反映する。status 変化時の cooldown とは分離する。
      name: nextName,
    };
    await ch.edit(patch);
    deps.log.info(
      `session-channel: title updated for ${input.sessionId} topic=ok name=${patch.name}`,
    );
  } catch (e) {
    deps.log.warn(`session-channel: title update failed for ${input.sessionId}: ${(e as Error).message}`);
  }
}

/**
 * 作業状態 (作業中⚙️ ⟷ 緑🟢) をチャンネル名の状態絵文字で切り替える。
 * Discord の rename レート制限 (2回/10分) に合わせ tryClaimRename の cooldown で best-effort。
 * session status が active のときだけ作用 (lost/ended は上書きしない)。エージェント絵文字 +
 * body は保持し、先頭の状態絵文字だけ差し替える。
 */
export async function onSessionWorkState(
  deps: SessionChannelDeps,
  input: { sessionId: string; working: boolean },
): Promise<void> {
  const row = deps.repo.findBySessionId(input.sessionId);
  if (!row || row.status !== "active") return;
  const ch = deps.guild.channels.cache.get(row.channel_id);
  if (!ch || ch.type !== ChannelType.GuildText) return;
  const desired = input.working ? "working" : "active";
  if (extractDisplayState(ch.name) === desired) return; // 既にその状態
  // rename rate limit guard — cooldown 内は skip (= 次の状態変化/title で収束)。
  if (!deps.repo.tryClaimRename(input.sessionId, RENAME_COOLDOWN_SEC)) {
    deps.log.info(
      `session-channel: work-state rename deferred for ${input.sessionId} (cooldown)`,
    );
    return;
  }
  try {
    const newName = applyStatusEmoji(ch.name, desired);
    await ch.edit({ name: newName, reason: `session ${input.sessionId} work-state=${desired}` });
    deps.log.info(`session-channel: ${input.sessionId} work-state → #${newName}`);
  } catch (e) {
    deps.log.warn(`session-channel: work-state rename failed for ${input.sessionId}: ${(e as Error).message}`);
  }
}

function titleToChannelBase(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[\[\]]+/g, "-")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 88);
  return s || "session";
}
