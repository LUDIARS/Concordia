/**
 * ナレッジ検索の手順 (spec/feature/slack-knowledge-search.md KS-2〜KS-10)。
 *
 * 要求の保存 → 受付返信 → 検索 → (0 件なら返して終わり) → 生成 → サマリー投稿 + HTML 添付。
 * 再送 (同じ要求鍵) は何もしない。 結果不明の投稿は再送しない (投稿の失敗は記録して終わる)。
 *
 * SRP: 手順の組み立て (application)。 Slack・DB・LLM はすべて注入された port。
 */

import type { OneShotRunner } from "../rules/render-patrol.js";
import { buildAnswerPrompt, parseAnswer, renderFallbackSources } from "./answer.js";
import { KNOWLEDGE_SEARCH_USAGE, type SearchCommand } from "./command.js";
import { renderKnowledgeHtml } from "./html-report.js";
import { rankDocuments, type SearchDoc } from "./rank.js";
import type { KnowledgeSearchRequestStore } from "./request-store.js";
import { buildTrialContext } from "./trial.js";

export const ANSWER_LIMITS = { model: "sonnet", timeoutMs: 120_000 } as const;

/** 返信先。 Slack の投稿・添付はこの port だけを通す。 */
export interface SearchReplyPort {
  /** 投稿する。 trialRequestId があれば「セッションを起動して試す」ボタンを付ける (KS-11)。 */
  post(text: string, options?: { trialRequestId?: number }): Promise<void>;
  attachHtml(filename: string, html: string, comment: string): Promise<void>;
}

export interface KnowledgeSearchDeps {
  requests: KnowledgeSearchRequestStore;
  loadDocs: () => SearchDoc[];
  runner: OneShotRunner;
  nowSec: () => number;
  log?: { warn(message: string): void };
}

export interface KnowledgeSearchInput {
  requestKey: string;
  channel: string;
  threadTs: string | null;
  userId: string | null;
  command: Exclude<SearchCommand, { kind: "none" }>;
}

export type KnowledgeSearchOutcome = "duplicate" | "usage" | "no_hits" | "answered" | "failed";

export async function runKnowledgeSearch(deps: KnowledgeSearchDeps, input: KnowledgeSearchInput, reply: SearchReplyPort): Promise<{ outcome: KnowledgeSearchOutcome; text: string }> {
  const query = input.command.kind === "search" ? input.command.query : "";
  const { created, request } = deps.requests.claim({
    requestKey: input.requestKey, channel: input.channel, threadTs: input.threadTs, userId: input.userId, query, nowSec: deps.nowSec(),
  });
  if (!created) return { outcome: "duplicate", text: "" };

  const send = async (text: string, options?: { trialRequestId?: number }): Promise<void> => {
    try { await reply.post(text, options); } catch (error) { deps.log?.warn(`knowledge search reply failed id=${request.id}: ${(error as Error).message}`); }
  };

  if (input.command.kind === "usage") {
    deps.requests.finish(request.id, "usage", 0, null, deps.nowSec());
    await send(KNOWLEDGE_SEARCH_USAGE);
    return { outcome: "usage", text: KNOWLEDGE_SEARCH_USAGE };
  }

  await send(`ナレッジ検索 #${request.id} を受け付けました。「${query}」を Notion とローカルのナレッジベースから探しています。`);
  let ranked;
  try {
    ranked = rankDocuments(query, deps.loadDocs());
  } catch (error) {
    const message = (error as Error).message;
    deps.requests.finish(request.id, "failed", 0, message, deps.nowSec());
    const text = `ナレッジ検索 #${request.id}: 検索に失敗しました。`;
    await send(text);
    return { outcome: "failed", text };
  }
  if (ranked.length === 0) {
    deps.requests.finish(request.id, "no_hits", 0, null, deps.nowSec());
    const text = `ナレッジ検索 #${request.id}: 「${query}」に当たる資料は見つかりませんでした。`;
    await send(text);
    return { outcome: "no_hits", text };
  }

  const result = await deps.runner(buildAnswerPrompt(query, ranked), { ...ANSWER_LIMITS, conversationOnly: true })
    .catch((error: unknown) => ({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
  const answer = result.ok ? parseAnswer(result.stdout, ranked) : null;
  if (!answer) {
    deps.requests.finish(request.id, "failed", ranked.length, result.ok ? "invalid_answer" : clipError(result.stderr), deps.nowSec());
    const text = `ナレッジ検索 #${request.id}: まとめの生成に失敗しました。見つかった資料:\n${renderFallbackSources(ranked)}`;
    await send(text);
    return { outcome: "failed", text };
  }

  deps.requests.finish(request.id, "answered", ranked.length, null, deps.nowSec());
  deps.requests.saveTrialContext(request.id, buildTrialContext({ requestId: request.id, query, answer, ranked }));
  const text = `*ナレッジ検索 #${request.id}: ${query}*\n${answer.summary}\n役職別の技術スキル・技術内容と出典 (${answer.sources.length} 件) は添付の HTML にあります。`;
  await send(text, { trialRequestId: request.id });
  try {
    const html = renderKnowledgeHtml({ query, requestId: request.id, createdAt: new Date(deps.nowSec() * 1000), answer });
    await reply.attachHtml(`knowledge-search-${request.id}.html`, html, `ナレッジ検索 #${request.id}`);
  } catch (error) {
    deps.log?.warn(`knowledge search attachment failed id=${request.id}: ${(error as Error).message}`);
  }
  return { outcome: "answered", text };
}

function clipError(message: string): string {
  return Array.from(message.trim() || "runner_failed").slice(0, 300).join("");
}
