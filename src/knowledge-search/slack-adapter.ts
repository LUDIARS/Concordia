/**
 * ナレッジ検索の Slack 入出力 (spec/feature/slack-knowledge-search.md KS-1, KS-9)。
 *
 * - メンション: Bot 宛ての「ナレッジ検索 <語>」。 返信は元の投稿のスレッド
 * - ワークフロー: カスタムステップ `knowledge_search` (inputs: query, channel_id)。 チャンネルに起点を投稿し、
 *   以降はそのスレッドへ返す。 ステップの出力 `result` に最後の本文を返す
 * - Bot 自身・他 bot・編集等の subtype 付き投稿は受け付けない
 *
 * SRP: Slack のイベント → 検索入力、 返信 port の実装だけ。
 */

import { parseMentionCommand, parseWorkflowQuery } from "./command.js";
import type { KnowledgeSearchRuntime } from "./runtime.js";
import type { SearchReplyPort } from "./search-use-case.js";
import { KNOWLEDGE_TRIAL_ACTION_ID, KNOWLEDGE_TRIAL_BUTTON_LABEL, parseTrialValue, type TrialSpawnPort } from "./trial.js";

export const KNOWLEDGE_SEARCH_FUNCTION_ID = "knowledge_search";

/** 使う Slack Web API の形だけ (テストで差し替える)。 */
export interface KnowledgeSearchSlackClient {
  chat: {
    postMessage(args: { channel: string; text: string; thread_ts?: string; unfurl_links?: boolean; blocks?: unknown[] }): Promise<{ ts?: string }>;
    postEphemeral(args: { channel: string; user: string; text: string; thread_ts?: string }): Promise<unknown>;
  };
  filesUploadV2(args: { channel_id: string; thread_ts?: string; initial_comment?: string; file_uploads: Array<{ file: Buffer; filename: string }> }): Promise<unknown>;
}

export interface KnowledgeSearchMessageEvent {
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}

/** 検索結果の本文と「セッションを起動して試す」ボタン (KS-11)。 */
export function trialBlocks(text: string, requestId: number): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: Array.from(text).slice(0, 2900).join("") } },
    { type: "actions", elements: [{ type: "button", action_id: KNOWLEDGE_TRIAL_ACTION_ID, value: String(requestId), text: { type: "plain_text", text: KNOWLEDGE_TRIAL_BUTTON_LABEL } }] },
  ];
}

function threadReply(client: KnowledgeSearchSlackClient, channel: string, threadTs: string | undefined): SearchReplyPort & { threadTs(): string | undefined } {
  let thread = threadTs;
  return {
    threadTs: () => thread,
    async post(text, options) {
      const blocks = options?.trialRequestId ? trialBlocks(text, options.trialRequestId) : undefined;
      const res = await client.chat.postMessage({ channel, text, unfurl_links: false, ...(thread ? { thread_ts: thread } : {}), ...(blocks ? { blocks } : {}) });
      if (!thread && res.ts) thread = res.ts;
    },
    async attachHtml(filename, html, comment) {
      await client.filesUploadV2({ channel_id: channel, ...(thread ? { thread_ts: thread } : {}), initial_comment: comment, file_uploads: [{ file: Buffer.from(html, "utf8"), filename }] });
    },
  };
}

export function knowledgeSearchSlack(deps: {
  runtime: KnowledgeSearchRuntime;
  client: KnowledgeSearchSlackClient;
  botUserId: () => string | null;
  /** セッション起動権限 (`/co-spawn` と同じ判定)。 */
  isLaunchAllowed: (userId: string) => boolean;
  spawner: TrialSpawnPort;
  log?: { warn(message: string): void };
}) {
  return {
    /**
     * 「セッションを起動して試す」ボタン。 対象のボタンなら処理して true。
     * 結果は押した人だけに見える ephemeral で返す。
     */
    async onTrialAction(input: { actionId?: string; value?: string; userId?: string; channelId?: string; threadTs?: string }): Promise<boolean> {
      if (input.actionId !== KNOWLEDGE_TRIAL_ACTION_ID) return false;
      const requestId = parseTrialValue(input.value);
      if (!requestId || !input.channelId || !input.userId) return true;
      const outcome = await deps.runtime.trial({ requestId, authorized: deps.isLaunchAllowed(input.userId) }, deps.spawner);
      try {
        await deps.client.chat.postEphemeral({ channel: input.channelId, user: input.userId, text: outcome.text, ...(input.threadTs ? { thread_ts: input.threadTs } : {}) });
      } catch (error) {
        deps.log?.warn(`knowledge trial reply failed: ${(error as Error).message}`);
      }
      return true;
    },
    /** メンションの検索コマンドなら検索を始めて true (完了は待たない)。 それ以外は false。 */
    onMessage(teamId: string | undefined, event: KnowledgeSearchMessageEvent): boolean {
      if (event.subtype || event.bot_id || !event.user || !event.channel || !event.ts) return false;
      const botUserId = deps.botUserId();
      if (event.user === botUserId) return false;
      const command = parseMentionCommand(event.text ?? "", botUserId);
      if (command.kind === "none") return false;
      const threadTs = event.thread_ts ?? event.ts;
      void deps.runtime.search(
        { requestKey: `slack:${teamId ?? "-"}:${event.channel}:${event.ts}`, channel: event.channel, threadTs, userId: event.user, command },
        threadReply(deps.client, event.channel, threadTs),
      ).catch((error: unknown) => deps.log?.warn(`knowledge search failed: ${(error as Error).message}`));
      return true;
    },
    /** ワークフローのステップを実行し、 ステップの出力にする本文を返す。 */
    async onFunction(input: { executionId: string; query?: string; channelId?: string; userId?: string }): Promise<string> {
      if (!input.channelId) throw new Error("channel_id が指定されていません");
      const reply = threadReply(deps.client, input.channelId, undefined);
      const result = await deps.runtime.search(
        { requestKey: `slack-function:${input.executionId}`, channel: input.channelId, threadTs: null, userId: input.userId ?? null, command: parseWorkflowQuery(input.query) },
        reply,
      );
      return result.text;
    },
  };
}
export type KnowledgeSearchSlack = ReturnType<typeof knowledgeSearchSlack>;
