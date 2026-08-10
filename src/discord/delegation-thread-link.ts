/**
 * 委託を起動した親セッションの面へ、起動できた子セッションの投稿リンクを 1 回だけ貼る。
 *
 * 委託の子は自分の forum 投稿を持つが、親からはそこへ辿る導線が無く、フォーラム一覧を
 * 目で探す必要があった (2026-08-09 neco 指示)。
 *
 * 「起動完了」を条件にするのは、子の面が作られるのが起動後だから。 起動前に貼っても
 * 行き先が無いリンクになる。
 */

import type { DiscordConfigRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";

/** 子の面が用意できたとみなす run status。 */
const STARTED_STATUSES = new Set(["running", "started", "active"]);

const LINK_POSTED_KEY_PREFIX = "delegation_thread_link_posted:";

/** 同一プロセス内で重なった run_changed handler の read/post/write 競合を直列化する。 */
const inFlightRunIds = new Set<string>();

export interface DelegationThreadLinkDeps {
  guildId: string;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  configRepo: DiscordConfigRepo;
  /** 親の面へ 1 メッセージ送る (webhook/bot どちらでもよい)。 */
  post: (channelId: string, content: string) => Promise<void>;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

export interface DelegationThreadLinkInput {
  runId: string;
  status: string;
  parentSessionId: string;
  childSessionId: string | null;
  /** 表示用の委託名 (template の call name など)。 無ければ run id を出す。 */
  label?: string | null;
}

export function threadUrl(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

/**
 * 条件が揃っていればリンクを貼る。 貼ったら true。
 *
 * 同じ run で二度貼らないよう、投稿済みフラグを config に残す。 run は status 変化の
 * たびにイベントを出すので、これが無いと同じリンクが並ぶ。
 */
export async function postDelegationThreadLink(
  deps: DelegationThreadLinkDeps,
  input: DelegationThreadLinkInput,
): Promise<boolean> {
  if (!STARTED_STATUSES.has(input.status)) return false;
  if (!input.childSessionId) return false;
  const key = `${LINK_POSTED_KEY_PREFIX}${input.runId}`;
  if (deps.configRepo.get(key)) return false;
  if (inFlightRunIds.has(input.runId)) return false;
  inFlightRunIds.add(input.runId);

  try {
    // lock 取得前に別 handler が完了している可能性があるため、永続 marker を再確認する。
    if (deps.configRepo.get(key)) return false;
    const parent = deps.sessionChannelsRepo.findBySessionId(input.parentSessionId);
    const child = deps.sessionChannelsRepo.findBySessionId(input.childSessionId);
    // 子の面がまだ無いだけなら、次の status 変化でまた試す (フラグは立てない)。
    if (!parent || !child) return false;

    const label = input.label?.trim() || input.runId;
    try {
      await deps.post(
        parent.channel_id,
        `🧵 委託を起動しました: **${label}** → ${threadUrl(deps.guildId, child.channel_id)}`,
      );
    } catch (error) {
      deps.log.warn(`delegation thread link post failed run=${input.runId}: ${(error as Error).message}`);
      return false;
    }
    deps.configRepo.set(key, String(Date.now()));
    deps.log.info(`delegation thread link posted run=${input.runId} parent=${input.parentSessionId}`);
    return true;
  } finally {
    // 投稿・channel lookup のどの失敗経路でも次の status event が再試行できるようにする。
    inFlightRunIds.delete(input.runId);
  }
}
