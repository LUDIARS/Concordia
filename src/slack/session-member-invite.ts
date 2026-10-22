/**
 * session channel へ常時招待メンバーを招待する。
 *
 * 常時招待メンバー = 設定画面で登録した Slack ユーザ ID の一覧。 起動者に関係なく、
 * すべての session channel に入れる (spec/feature/slack-platform.md)。
 * 招待は通知のための補助なので、 失敗しても channel 作成・中継は止めない (warn のみ)。
 *
 * SRP: 一覧の正規化と招待 API 呼び出しのみ。 永続化は config.ts、 起動者の招待は
 * session-starter-invite.ts。
 */

import { slackApiErrorCode } from "./session-channel-provisioner.js";
import type { SlackInviteClient } from "./session-starter-invite.js";

const SLACK_ID = /^[UW][A-Z0-9]{2,31}$/;
const MAX_MEMBERS = 50;

/** 入力を検証して正規化する。 空白除去・重複除去。 形式違反は Error (呼び出し側が 400 にする)。 */
export function normalizeSlackAlwaysInvite(userIds: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const raw of userIds) {
    const id = raw.trim();
    if (!SLACK_ID.test(id)) throw new Error(`invalid Slack user id: ${id}`);
    unique.add(id);
  }
  if (unique.size > MAX_MEMBERS) throw new Error(`too many always-invite members (max ${MAX_MEMBERS})`);
  return [...unique];
}

/** 保存済み JSON を読む。 壊れた値は空扱い (招待しないだけで、 session は止めない)。 */
export function parseSlackAlwaysInvite(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeSlackAlwaysInvite(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return [];
  }
}

export interface SlackAlwaysInviterDeps {
  client: SlackInviteClient;
  /** 招待のたびに読む (設定変更を再起動なしで反映する)。 */
  resolveMembers: () => string[];
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

/** 招待済みとみなしてよい Slack の応答。 */
const DONE_CODES = new Set(["already_in_channel", "cant_invite_self"]);

export class SlackAlwaysInviter {
  /** `${sessionId}\u0000${userId}` の招待済み記録。 */
  private readonly done = new Set<string>();

  constructor(private readonly deps: SlackAlwaysInviterDeps) {}

  /** 1 人ずつ招待する (複数指定だと 1 人の失敗で全員が招待されないため)。 失敗した人は次の契機で再試行する。 */
  async invite(sessionId: string, channelId: string): Promise<void> {
    for (const userId of this.deps.resolveMembers()) {
      const key = `${sessionId}\u0000${userId}`;
      if (this.done.has(key)) continue;
      try {
        await this.deps.client.conversations.invite({ channel: channelId, users: userId });
        this.done.add(key);
        this.deps.log?.info(`Slack always-invite member invited session=${sessionId} channel=${channelId} user=${userId}`);
      } catch (error) {
        const code = slackApiErrorCode(error);
        if (code && DONE_CODES.has(code)) {
          this.done.add(key);
          continue;
        }
        this.deps.log?.warn(
          `Slack always-invite failed session=${sessionId} channel=${channelId} user=${userId}: ${code ?? (error as Error).message}`,
        );
      }
    }
  }

  /** session 終了時に呼び、 プロセス内の記録を捨てる。 */
  forget(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.done) if (key.startsWith(prefix)) this.done.delete(key);
  }
}
