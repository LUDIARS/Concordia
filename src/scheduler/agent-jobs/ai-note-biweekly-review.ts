/**
 * AIノート記事 隔週レビュー (`ai-note-biweekly-review`) の外部エージェント版。
 * 選定 (mutable かつ 14 日以上前) は Cc が行い、 題・URL・前回所見を渡して現行化の下書きを返してもらう。
 * Notion への書き込みは Cc の委託側の仕事 (今回は下書きの投稿まで)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — AIノート
 */

import { composeAgentBody } from "./body.js";
import type { AgentJobSpec } from "./types.js";

export const AI_NOTE_BIWEEKLY_REVIEW_JOB = "ai-note-biweekly-review";

/** これ以上前に見た mutable 記事を対象にする (委託版の手順と同じ)。 */
export const AI_NOTE_REVIEW_AGE_DAYS = 14;

export interface AiNoteArticle {
  title: string;
  section: string | null;
  universality: string | null;
  /** YYYY-MM-DD。 未レビューは null。 */
  lastReviewed: string | null;
  note: string | null;
  url: string | null;
}

export interface AiNoteSources {
  aiNoteArticles(): Promise<AiNoteArticle[]>;
  lastDoneSummary(job: string): string | null;
}

/** evergreen を除き、 最終レビューが古い順 (未レビューが先頭)。 */
export function selectAiNoteTargets(articles: readonly AiNoteArticle[], now: Date): AiNoteArticle[] {
  const cutoff = now.getTime() - AI_NOTE_REVIEW_AGE_DAYS * 86_400_000;
  return articles
    .filter((article) => article.universality !== "evergreen")
    .filter((article) => {
      if (!article.lastReviewed) return true;
      const at = Date.parse(`${article.lastReviewed}T00:00:00+09:00`);
      return !Number.isFinite(at) || at <= cutoff;
    })
    .sort((a, b) => (a.lastReviewed ?? "").localeCompare(b.lastReviewed ?? ""));
}

export function createAiNoteBiweeklyReviewJob(sources: AiNoteSources): AgentJobSpec {
  return {
    jobName: AI_NOTE_BIWEEKLY_REVIEW_JOB,
    resultKind: "下書き",
    body: composeAgentBody([
      "「AIノート」記事の隔週レビューで、 現行化の下書きを作る回です。",
      "",
      "params.data.articles は今回の対象 (流行やツール更新の影響を受けうる記事のうち、 最終レビューが 14 日以上前のもの) です。",
      "記事ごとに、 古くなっていそうな事実主張 (ポート・API・コマンド・料金・仕様・数値) と、 内容・文体・構成を変えない最小の直し方の案を",
      "detail.items に返してください。 本文が読めない記事は「本文を確認できず」とし、 推測で直し案を作らないでください。",
    ]),
    async buildData(context) {
      const articles = selectAiNoteTargets(await sources.aiNoteArticles(), context.firedAt).map((article) => ({
        title: article.title,
        section: article.section,
        last_reviewed: article.lastReviewed,
        note: article.note,
        url: article.url,
      }));
      return {
        date: context.args.date ?? null,
        previous_summary: sources.lastDoneSummary(AI_NOTE_BIWEEKLY_REVIEW_JOB),
        articles,
      };
    },
  };
}
