/**
 * session channel へ起動者を招待する。
 *
 * 起動者 = session の最も古い人間 inject の入力者。 Slack 起動はそのまま、 Discord
 * 起動はメンバー対応表で Slack ユーザに引いて `conversations.invite` する。
 * 招待は通知のための補助なので、 失敗しても channel 作成・中継は止めない (warn のみ)。
 *
 * SRP: 招待先の決定と招待 API 呼び出しのみ。 channel 作成は provisioner、
 * 対応表の解決は member-map.ts。
 */

import type { Requester } from "../control/requester.js";
import { resolveSlackInvitee, type SlackMemberMapEntry } from "./member-map.js";
import { slackApiErrorCode } from "./session-channel-provisioner.js";

export interface SlackInviteClient {
  conversations: {
    invite(args: { channel: string; users: string }): Promise<unknown>;
  };
}

export interface SlackSessionStarterInviterDeps {
  client: SlackInviteClient;
  /** DB 上の起動者。 最初の inject がまだ永続化されていなければ null。 */
  resolveStarter: (sessionId: string) => Requester | null;
  /** 招待のたびに読む (設定変更を再起動なしで反映する)。 */
  resolveMemberMap: () => SlackMemberMapEntry[];
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

/** 招待済みとみなしてよい Slack の応答。 */
const DONE_CODES = new Set(["already_in_channel", "cant_invite_self"]);

export class SlackSessionStarterInviter {
  private readonly done = new Set<string>();

  constructor(private readonly deps: SlackSessionStarterInviterDeps) {}

  /**
   * 起動者を channel に招待する。 起動者が未確定・対応表に無い場合は何もせず、
   * 次の契機 (人間 inject) で再試行できるよう未完了のまま残す。
   * `hint` は今届いた人間 inject の入力者。 DB に起動者がまだ無いときだけ使う。
   */
  async invite(sessionId: string, channelId: string, hint: Requester | null = null): Promise<void> {
    if (this.done.has(sessionId)) return;
    const starter = this.deps.resolveStarter(sessionId) ?? hint;
    if (!starter) return;
    const slackUserId = resolveSlackInvitee(starter, this.deps.resolveMemberMap());
    if (!slackUserId) {
      this.deps.log?.info(
        `Slack session starter has no Slack mapping session=${sessionId} platform=${starter.platform}`,
      );
      return;
    }
    try {
      await this.deps.client.conversations.invite({ channel: channelId, users: slackUserId });
      this.done.add(sessionId);
      this.deps.log?.info(`Slack session starter invited session=${sessionId} channel=${channelId}`);
    } catch (error) {
      const code = slackApiErrorCode(error);
      if (code && DONE_CODES.has(code)) {
        this.done.add(sessionId);
        return;
      }
      this.deps.log?.warn(
        `Slack session starter invite failed session=${sessionId} channel=${channelId}: ${code ?? (error as Error).message}`,
      );
    }
  }

  /** session 終了時に呼び、 プロセス内の記録を捨てる。 */
  forget(sessionId: string): void {
    this.done.delete(sessionId);
  }
}
