/**
 * 管制のまとめ・側セッション・API から、判断が要るセッションへ飛ぶリンクを組み立てる (純関数)。
 *
 * 2026-11-21 neco 指示「判断が必要なものについて管制から各セッションへリンクを貼って飛べるようにする」。
 *
 * - 未回答の質問カードがあれば、そのカードのメッセージ URL を優先する (`humanTodoQuestionLink`)。
 * - 無ければセッションの Discord チャンネル/スレッドの URL `https://discord.com/channels/<guild>/<channel>`。
 * - guild は対応表の scope で決める ('' = 本社、`sub:<id>` = 子会社)。id が snowflake でなければ null。
 * - 引けないとき・照会が例外を投げたときはリンク無し (null)。まとめの投稿や API を止めない。
 *
 * @implements spec/feature/control-session.md §10 判断待ちのセッションへのリンク
 */
import type { ControlBoardRow } from "./board-repo.js";
import {
  humanTodoQuestionLink,
  type HumanTodoQuestionCard,
  type HumanTodoQuestionLinkDeps,
} from "../control/human-todo-question-link.js";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const SUBSIDIARY_SCOPE_PREFIX = "sub:";

export type ControlBoardRowWithLink = ControlBoardRow & { link?: string | null };

export interface ControlSessionLinkDeps extends HumanTodoQuestionLinkDeps {
  /** そのセッションの最新の未回答の質問カード (無ければ null)。 */
  latestUnansweredQuestion: (sessionId: string) => HumanTodoQuestionCard | null;
}

export type SessionLinkResolver = (sessionId: string) => string | null;

/** 質問カードのメッセージ URL を優先し、無ければセッションのチャンネル/スレッドの URL。 */
export function controlSessionLink(deps: ControlSessionLinkDeps, sessionId: string): string | null {
  const card = deps.latestUnansweredQuestion(sessionId);
  if (card) {
    const cardLink = humanTodoQuestionLink(deps, card);
    if (cardLink) return cardLink;
  }
  const channel = deps.sessionChannel(sessionId);
  if (!channel) return null;
  const guildId = channel.scope.startsWith(SUBSIDIARY_SCOPE_PREFIX)
    ? deps.subsidiaryGuildId(channel.scope.slice(SUBSIDIARY_SCOPE_PREFIX.length))
    : deps.hqGuildId();
  if (!isSnowflake(guildId) || !isSnowflake(channel.channel_id)) return null;
  return `https://discord.com/channels/${guildId}/${channel.channel_id}`;
}

/** 例外をリンク無しにして警告ログに残す。無ければ常に null を返す解決器。 */
export function safeLinkResolver(
  resolve: SessionLinkResolver | undefined,
  log: { warn(message: string): void },
): SessionLinkResolver {
  if (!resolve) return () => null;
  return (sessionId) => {
    try {
      return resolve(sessionId) ?? null;
    } catch (error) {
      log.warn(`control session link failed (${sessionId}): ${String(error)}`);
      return null;
    }
  };
}

/** ボードの行にリンクを添える。リンクが引けない行は link: null。 */
export function withSessionLinks(rows: readonly ControlBoardRow[], linkOf: SessionLinkResolver): ControlBoardRowWithLink[] {
  return rows.map((row) => ({ ...row, link: linkOf(row.session_id) }));
}

function isSnowflake(value: string | null | undefined): value is string {
  return typeof value === "string" && DISCORD_SNOWFLAKE.test(value);
}
