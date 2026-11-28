/**
 * ナレッジ検索の組み立て (composition root から呼ぶ。 spec/feature/slack-knowledge-search.md)。
 *
 * 要求台帳・タグ保存・文書の読み出し・LLM runner を結び、 検索の実行とタグ付与の定期処理を返す。
 * SRP: 配線だけ。 判断は rank/answer/command、 手順は search-use-case/tagger。
 */

import type { Database } from "better-sqlite3";
import type { OneShotRunner } from "../rules/render-patrol.js";
import { loadCorpus } from "./corpus.js";
import { knowledgeSearchRequestStore } from "./request-store.js";
import { runKnowledgeSearch, type KnowledgeSearchInput, type SearchReplyPort } from "./search-use-case.js";
import { knowledgeSearchTagStore } from "./tag-store.js";
import { attachTags, tagNextDocuments } from "./tagger.js";
import { startKnowledgeTrial, type TrialOutcome, type TrialSpawnPort } from "./trial.js";

export const KNOWLEDGE_SEARCH_TAG_TICK_MS = 5 * 60_000;

export interface KnowledgeSearchRuntime {
  search(input: KnowledgeSearchInput, reply: SearchReplyPort): ReturnType<typeof runKnowledgeSearch>;
  /** タグ付与を 1 回進める。 */
  tagTick(): Promise<number>;
  /** 「セッションを起動して試す」 (KS-11)。 */
  trial(input: { requestId: number; authorized: boolean }, spawner: TrialSpawnPort): Promise<TrialOutcome>;
}

export function buildKnowledgeSearchRuntime(deps: { db: Database; runner: OneShotRunner; nowSec?: () => number; log?: { warn(message: string): void } }): KnowledgeSearchRuntime {
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const requests = knowledgeSearchRequestStore(deps.db);
  const tags = knowledgeSearchTagStore(deps.db);
  const loadDocs = () => attachTags(loadCorpus(deps.db), tags);
  let tagging = false;
  return {
    trial: (input, spawner) => startKnowledgeTrial({ requests, spawner }, input),
    search: (input, reply) => runKnowledgeSearch({ requests, loadDocs, runner: deps.runner, nowSec, ...(deps.log ? { log: deps.log } : {}) }, input, reply),
    async tagTick() {
      if (tagging) return 0;
      tagging = true;
      try {
        return await tagNextDocuments({ loadDocs: () => loadCorpus(deps.db), store: tags, runner: deps.runner, nowSec, ...(deps.log ? { log: deps.log } : {}) });
      } finally {
        tagging = false;
      }
    },
  };
}
