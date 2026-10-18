/**
 * Notion のページの取得経路の選び方 (spec/feature/patrol-chat.md「知識」の「Notion 記事マップ」)。
 *
 * 公開 URL (*.notion.site) が分かるページは公開ページのクロールを先に試し、 取れなければ MCP。 それ以外は MCP だけ。
 */

import { isPublicNotionUrl } from "./notion-source-public.js";
import type { NotionPageRef, NotionPageSource } from "./notion-source-types.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:26babd38 */
import augurContract_140b2c91 from './notion-route.contract.js'; /* augur-inject:contract-predicate:a00df731 */

export type NotionRoute = "public" | "mcp";

/** 試す経路の順。 */
export function notionRoutesFor(ref: Pick<NotionPageRef, "url">): NotionRoute[] {
  return isPublicNotionUrl(ref.url) ? ["public", "mcp"] : ["mcp"];
}
// @ts-expect-error augur-inject
notionRoutesFor = contract(notionRoutesFor, { ...augurContract_140b2c91, contractId: 'chat-knowledge-C-13', mode: 'observe', sample: 1, where: 'src/rules/notion-source-route.ts:13', rule: 'contract-wrap', id: '140b2c91' }); /* augur-inject:contract-wrap:140b2c91 */

export function createRoutedNotionSource(sources: { public: NotionPageSource; mcp: NotionPageSource }): NotionPageSource {
  return {
    fetchPage: async (ref, limits) => {
      for (const route of notionRoutesFor(ref)) {
        const page = await sources[route].fetchPage(ref, limits);
        if (page) return page;
      }
      return null;
    },
  };
}
