/**
 * 人間がセッションのチャンネルへ戻ってきたときに出す「未回答の質問」通知 (純関数)。
 *
 * 時間駆動では、滞留項目が再起動後に一斉投稿され、終了済みセッションまで催促する。
 * 代わりに **人間の再訪を検知してから、そのセッションの分だけ出す**:
 *
 * - トリガーは「そのセッションのチャンネルへの人間の投稿」。 セッション単位で独立する
 * - 対象は **アクティブなセッション** の **未回答の質問** だけ
 * - 元の質問メッセージへのリンクを付ける (遡らずに答えに行ける)
 * - メンションは **担当者 1 人だけ** (直近の人間指示者。不在なら設定済み管理者)
 *
 * SRP: 文面の組み立てのみ。 対象の抽出・メンション ID の解決・投函は呼び出し側。
 *
 * @implements spec/feature/approval-inbox.md §3.2
 */

import { escapeNotificationText } from "./notification-text.js";

/** 通知に載せる未回答質問の最小形。 正本は discord_pending_questions。 */
export interface PendingQuestionRef {
  readonly id: number;
  readonly question: string;
  /** 元の質問メッセージ。 null ならリンクを付けない (古い行は持っていない)。 */
  readonly discordMessageId: string | null;
  /** 質問した時刻 (epoch 秒)。 */
  readonly ts: number;
}

export interface SessionReturnNoticeInput {
  readonly questions: readonly PendingQuestionRef[];
  /** リンク組み立て用。 null なら本文にリンクを出さない。 */
  readonly guildId: string | null;
  readonly channelId: string | null;
  /** 一覧に出す上限。 既定 5 件 (戻ってきた人の画面を埋めない)。 */
  readonly maxListed?: number;
}

const DEFAULT_MAX_LISTED = 5;
const MAX_QUESTION_SUMMARY_CHARS = 240;
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

/**
 * 同じセッションへ続けて出さない間隔。 人間が戻ってきた直後は何度も投稿するので、
 * 1 度出したらしばらく黙る。
 */
export const DEFAULT_RETURN_COOLDOWN_MS = 30 * 60_000;

export interface ShouldNotifyInput {
  /** セッションが active か。 終了済みセッションの質問はもう誰も答えられない。 */
  readonly sessionActive: boolean;
  readonly unansweredCount: number;
  /** 同じセッションへ最後に出した時刻 (epoch ms)。 未通知は null。 */
  readonly lastNotifiedAt: number | null;
  readonly nowMs: number;
  readonly cooldownMs?: number;
}

/**
 * 人間の再訪で通知を出すべきか。
 *
 * - アクティブなセッションだけ
 * - 未回答が 1 件以上あるときだけ
 * - 直近に出していないときだけ (cooldown)
 *
 * @implements spec/feature/approval-inbox.md §3.2
 */
export function shouldNotifyOnReturn(input: ShouldNotifyInput): boolean {
  if (!input.sessionActive) return false;
  if (input.unansweredCount <= 0) return false;
  const cooldownMs = input.cooldownMs ?? DEFAULT_RETURN_COOLDOWN_MS;
  if (input.lastNotifiedAt === null) return true;
  return input.nowMs - input.lastNotifiedAt >= cooldownMs;
}

/**
 * 未回答質問の通知文を返す。 0 件なら null (通知しない)。
 *
 * 本文に `<@id>` は書かない。 メンションは呼び出し側が `mention_user_ids` の
 * 構造化フィールドで渡す (egress は `allowedMentions: { parse: [] }` で送るため、
 * 本文に紛れた文字列は発火しない)。 質問文は人間が書いた文字列なので、
 * `escapeNotificationText` を通してから載せる。
 *
 * @implements spec/feature/approval-inbox.md §3.2
 */
export function buildSessionReturnNotice(input: SessionReturnNoticeInput): string | null {
  const questions = input.questions;
  if (questions.length === 0) return null;

  const maxListed = input.maxListed ?? DEFAULT_MAX_LISTED;
  const oldestFirst = [...questions].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const listed = oldestFirst.slice(0, maxListed);

  const lines: string[] = [];
  lines.push(`このセッションに未回答の質問が ${questions.length} 件あります。`);
  for (const question of listed) {
    const link = messageLink(input.guildId, input.channelId, question.discordMessageId);
    const summary = summarizeQuestion(question.question);
    lines.push(link ? `- ${summary} ${link}` : `- ${summary}`);
  }
  if (oldestFirst.length > listed.length) {
    lines.push(`- ほか ${oldestFirst.length - listed.length} 件`);
  }
  return lines.join("\n");
}

/** Discord のメッセージ URL。 3 つ揃わないと組めないので null を返す。 */
export function messageLink(
  guildId: string | null,
  channelId: string | null,
  messageId: string | null,
): string | null {
  if (
    !guildId || !DISCORD_SNOWFLAKE.test(guildId)
    || !channelId || !DISCORD_SNOWFLAKE.test(channelId)
    || !messageId || !DISCORD_SNOWFLAKE.test(messageId)
  ) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** 未信頼の質問を 1 行かつ通知全体が Discord 上限に収まる長さへ縮める。 */
function summarizeQuestion(question: string): string {
  const oneLine = escapeNotificationText(question).replace(/\s+/gu, " ").trim();
  if (oneLine.length <= MAX_QUESTION_SUMMARY_CHARS) return oneLine;
  return `${oneLine.slice(0, MAX_QUESTION_SUMMARY_CHARS - 1)}…`;
}
