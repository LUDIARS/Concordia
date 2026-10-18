import { contract } from './ontime-runtime.js'; /* augur-inject:import:917b9656 */
import augurContract_b762dafd from './human-todo-question-link.contract.js'; /* augur-inject:contract-predicate:d49eaba2 */
import augurContract_8b6151b0 from './human-todo-message-url.contract.js'; /* augur-inject:contract-predicate:b2d6e52f */
/**
 * 「人間のやること」の未回答質問に付ける、質問カードへのリンクの組み立て (純関数)。
 *
 * 2026-10-18 neco 指示「人間のやることの部分。(未回答の質問の) リンクサジェストが無い。
 * 質問のリンクを付けるようにしましょう」。
 *
 * - リンクは Discord のメッセージ URL `https://discord.com/channels/<guild>/<channel>/<message>`。
 * - チャンネルはカードを実際に投稿したチャンネル (`discord_channel_id`) を優先し、無ければ
 *   セッションの Discord チャンネル/スレッドの対応表から引く。
 * - guild はセッションのチャンネル行の scope で決める ('' = 本社、`sub:<id>` = 子会社)。
 *   対応表に行が無いセッションは guild を決められないので付けない。
 * - どれかが引けなければ null (リンク無しで今どおり出す)。Slack 等は質問カードの
 *   メッセージ位置を持たないので URL を作らない。
 *
 * @implements spec/feature/autonomous-work-continuation.md §2 人間のやることの報告
 */

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const SUBSIDIARY_SCOPE_PREFIX = "sub:";

export interface HumanTodoQuestionCard {
  session_id: string;
  discord_message_id: string | null;
  discord_channel_id: string | null;
}

export interface HumanTodoQuestionLinkDeps {
  /** セッションの Discord チャンネル/スレッドと、その scope ('' = 本社)。 */
  sessionChannel: (sessionId: string) => { channel_id: string; scope: string } | null;
  hqGuildId: () => string | null;
  subsidiaryGuildId: (subsidiaryId: string) => string | null;
}

/** 3 つの id がすべて Discord の snowflake のときだけ URL を返す。 */
export function discordMessageUrl(input: {
  guildId: string | null | undefined;
  channelId: string | null | undefined;
  messageId: string | null | undefined;
}): string | null {
  const { guildId, channelId, messageId } = input;
  if (!isSnowflake(guildId) || !isSnowflake(channelId) || !isSnowflake(messageId)) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
// @ts-expect-error augur-inject
discordMessageUrl = contract(discordMessageUrl, { ...augurContract_8b6151b0, contractId: 'human-todo-link-C-19', mode: 'observe', sample: 1, where: 'src/control/human-todo-question-link.ts:35', rule: 'contract-wrap', id: '8b6151b0' }); /* augur-inject:contract-wrap:8b6151b0 */

export function humanTodoQuestionLink(deps: HumanTodoQuestionLinkDeps, card: HumanTodoQuestionCard): string | null {
  if (!isSnowflake(card.discord_message_id)) return null;
  // 対応表に無いセッションは guild (本社/子会社) を決められないので付けない。
  const channel = deps.sessionChannel(card.session_id);
  if (!channel) return null;
  const channelId = card.discord_channel_id || channel.channel_id;
  const scope = channel.scope;
  const guildId = scope.startsWith(SUBSIDIARY_SCOPE_PREFIX)
    ? deps.subsidiaryGuildId(scope.slice(SUBSIDIARY_SCOPE_PREFIX.length))
    : deps.hqGuildId();
  return discordMessageUrl({ guildId, channelId, messageId: card.discord_message_id });
}
// @ts-expect-error augur-inject
humanTodoQuestionLink = contract(humanTodoQuestionLink, { ...augurContract_b762dafd, contractId: 'human-todo-link-C-18', mode: 'observe', sample: 1, where: 'src/control/human-todo-question-link.ts:45', rule: 'contract-wrap', id: 'b762dafd' }); /* augur-inject:contract-wrap:b762dafd */

function isSnowflake(value: string | null | undefined): value is string {
  return typeof value === "string" && DISCORD_SNOWFLAKE.test(value);
}
