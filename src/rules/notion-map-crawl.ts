/**
 * Notion 記事マップのクロール (spec/feature/patrol-chat.md「知識」の「Notion 記事マップ」)。
 *
 *   起点ごとに: ページを取る (公開ページのクロール → 取れなければ MCP) → 子ページ (子データベースの行を含む) へ下る
 *
 * - 起点は設定のページだけ。 Notion の公式 API と連携トークンは使わない (neco 指示 2026-10-18)
 * - 除外: 題名やパスに除外語を含むページとその配下は読まない。 親の一覧で題が分かる子ページは取る前に判定する。
 *   秘匿語に当たるページも同じ扱い。 除外したページは題名・本文とも保存せず、 起点ごとの件数だけを数える
 * - 差分: 最終更新 (経路が教えてくれなければ本文の指紋) が前回と同じページは解析し直さない (前回の要約を残す)。
 *   手動の取り直し (full) は全ページを解析し直す
 * - 上限: 深さ・起点ごとのページ数・ページごとの本文バイト (設定)・ページごとの子ページ数
 * - 失敗: 起点ごとに独立。 起点のページが取れない起点は前回のページ・辺・断片を残し、 失敗理由だけを記録する。
 *   起点の配下の 1 ページが取れない (「使えない」と答えた場合も含む) ときは、 そのページ (と配下) だけを飛ばして続ける (読めた分を捨てない)
 * - 起点の配下に別の起点があるときは、 そこで下るのを止める (そのページはその起点が自分で読む)
 *   MCP が使えない (未認証・コネクタ無し) は「未設定」として Notion の取り込みだけを止める
 */

import { createHash } from "node:crypto";
import type { CrawledMapPage, NotionMapRepo } from "../db/notion-map-repo.js";
import type { NotionMapRootsRepo } from "../db/notion-map-roots-repo.js";
import { redactReason } from "./knowledge-ingest.js";
import type { KnowledgeCollector, KnowledgeDoc } from "./knowledge-types.js";
import { isExcludedPage, joinPath } from "./notion-map-rules.js";
import { NOTION_MAP_CHILDREN_PER_PAGE, type NotionEdge, type NotionMapLimits } from "./notion-map-types.js";
import { NotionSourceUnavailable, type NotionPageRef, type NotionPageSource } from "./notion-source-types.js";

export interface NotionMapCrawlDeps {
  /** ページの取得経路 (公開ページのクロール → MCP)。 */
  source: NotionPageSource;
  repo: NotionMapRepo;
  /** 起点ごとの状態 (ページ数・除外数・最終取得・失敗理由)。 */
  rootStates: NotionMapRootsRepo;
  /** 起点 (正規化済みの ID と、 分かれば公開 URL)。 */
  roots: () => Array<{ id: string; url: string | null }>;
  /** 除外語 (既定 + 設定)。 */
  excludes: () => string[];
  limits: () => NotionMapLimits;
  /** 秘匿語の辞書 (読めなければ空)。 */
  confidentialTerms: () => Promise<string[]>;
  nowMs: () => number;
  log?: { warn: (msg: string) => void };
}

export interface RootCrawlResult {
  rootId: string;
  status: "ok" | "failed";
  pages: number;
  excluded: number;
  changed: number;
  /** 取れなかった配下のページの数 (起点のページは含まない)。 */
  failedPages?: number;
  reason?: string;
}

const hitsConfidential = (texts: string[], terms: readonly string[]): boolean => {
  const hay = texts.join("\n").toLowerCase();
  return terms.some((t) => t.trim() !== "" && hay.includes(t.trim().toLowerCase()));
};

const contentHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

interface CrawlOpts {
  full: boolean;
  visited: Set<string>;
  /** 設定の起点。 別の起点の配下に現れても、 その起点が自分で読む。 */
  rootIds: Set<string>;
  words: string[];
  terms: string[];
  limits: NotionMapLimits;
}

export function createNotionMapCollector(deps: NotionMapCrawlDeps): KnowledgeCollector & { lastReport(): RootCrawlResult[] | null } {
  let report: RootCrawlResult[] | null = null;
  const nowSec = () => Math.floor(deps.nowMs() / 1000);

  const crawlRoot = async (root: { id: string; url: string | null }, opts: CrawlOpts, docs: KnowledgeDoc[]): Promise<RootCrawlResult> => {
    const pages: CrawledMapPage[] = [];
    const edges: NotionEdge[] = [];
    const rootDocs: KnowledgeDoc[] = [];
    let excluded = 0;
    let failedPages = 0;
    let rootTitle: string | null = null;
    const fetchLimits = { pageTextBytes: opts.limits.pageTextBytes, maxChildren: NOTION_MAP_CHILDREN_PER_PAGE };
    const queue: Array<{ ref: NotionPageRef; parentPath: string | null; depth: number }> = [
      { ref: { id: root.id, url: root.url, title: null }, parentPath: null, depth: 0 },
    ];
    while (queue.length > 0 && pages.length < opts.limits.maxPages) {
      const item = queue.shift()!;
      if (item.depth > 0 && opts.rootIds.has(item.ref.id)) continue;
      if (opts.visited.has(item.ref.id)) continue;
      opts.visited.add(item.ref.id);
      // 親の一覧で題が分かれば、 取る前に除外を判定する (個人ページを取りに行かない)
      if (item.ref.title) {
        const hint = joinPath(item.parentPath, item.ref.title);
        if (isExcludedPage(item.ref.title, hint, opts.words) || hitsConfidential([item.ref.title, hint], opts.terms)) {
          excluded += 1;
          continue;
        }
      }
      let page;
      try {
        page = await deps.source.fetchPage(item.ref, fetchLimits);
      } catch (err) {
        // 起点のページが取れないときは起点ごと止める (MCP が使えないならクロール全体を止める)。
        // 配下の 1 ページの失敗は「使えない」と答えたときも含めてそのページだけを飛ばす
        // (同じ起点で読めていたのに LLM がツールを呼ばずに unavailable と答えて全体が止まった実例がある)
        if (item.depth === 0) throw err;
        failedPages += 1;
        deps.log?.warn(`notion map: page ${item.ref.id} under root ${root.id} failed: ${redactReason((err as Error).message || String(err), [])}`);
        continue;
      }
      if (!page) {
        if (item.depth === 0) throw new Error("root page is not reachable (not public and not shared with the Notion connector)");
        continue;
      }
      const path = joinPath(item.parentPath, page.title);
      if (isExcludedPage(page.title, path, opts.words) || hitsConfidential([page.title, path, page.text], opts.terms)) {
        excluded += 1;
        continue;
      }
      if (item.depth === 0) rootTitle = page.title;
      const hash = contentHash(page.text);
      const prior = deps.repo.page(page.id);
      const changed = opts.full || !prior || prior.path !== path
        || (page.lastEditedMs !== null ? prior.last_edited_ms !== page.lastEditedMs : prior.content_hash !== hash);
      for (const child of page.children) edges.push({ from: page.id, to: child.id, kind: "child" });
      for (const to of page.links) edges.push({ from: page.id, to, kind: "link" });
      if (changed) {
        rootDocs.push({
          docType: "notion-page",
          docKey: `notion:${page.id}`,
          title: page.title,
          url: page.url,
          repo: null,
          path,
          // Notion の断片は常に本社限定
          scope: "hq",
          text: page.text,
          sourceUpdatedAt: page.lastEditedMs === null ? null : Math.floor(page.lastEditedMs / 1000),
        });
      }
      pages.push({
        page_id: page.id,
        root_id: root.id,
        title: page.title,
        url: page.url,
        path,
        depth: item.depth,
        last_edited_ms: page.lastEditedMs,
        content_hash: hash,
        summary: changed ? null : prior!.summary,
        keywords: changed ? [] : prior!.keywords,
        analysis_pending: changed ? true : prior!.analysis_pending,
      });
      if (item.depth >= opts.limits.maxDepth) continue;
      for (const child of page.children) queue.push({ ref: child, parentPath: path, depth: item.depth + 1 });
    }
    deps.repo.replaceRoot(root.id, pages, edges, nowSec());
    deps.rootStates.markRootSuccess(root.id, { title: rootTitle ?? root.id, pages: pages.length, excluded }, nowSec());
    docs.push(...rootDocs);
    return { rootId: root.id, status: "ok", pages: pages.length, excluded, changed: rootDocs.length, failedPages };
  };

  const collect: KnowledgeCollector = async ({ full }) => {
    const roots = deps.roots();
    if (roots.length === 0) return { notConfigured: "notion map has no root pages" };
    const ids = roots.map((r) => r.id);
    deps.repo.dropRootsExcept(ids);
    deps.rootStates.dropExcept(ids);
    const opts: CrawlOpts = { full, visited: new Set<string>(), rootIds: new Set(ids), words: deps.excludes(), terms: await deps.confidentialTerms(), limits: deps.limits() };
    const docs: KnowledgeDoc[] = [];
    const results: RootCrawlResult[] = [];
    for (const root of roots) {
      deps.rootStates.markRootAttempt(root.id, nowSec());
      try {
        results.push(await crawlRoot(root, opts, docs));
      } catch (err) {
        const reason = redactReason((err as Error).message || String(err), []);
        deps.rootStates.markRootFailure(root.id, reason, nowSec());
        // MCP が使えない: Notion の取り込みだけを「未設定」で止める (前回の断片・マップは残す)
        if (err instanceof NotionSourceUnavailable) {
          report = [...results, { rootId: root.id, status: "failed", pages: 0, excluded: 0, changed: 0, reason }];
          return { notConfigured: reason };
        }
        deps.log?.warn(`notion map: root ${root.id} failed: ${reason}`);
        results.push({ rootId: root.id, status: "failed", pages: 0, excluded: 0, changed: 0, reason });
      }
    }
    report = results;
    const failed = results.filter((r) => r.status === "failed");
    // 全部の起点が失敗したら種類として失敗にする (前回の断片を残す)
    if (failed.length === results.length) throw new Error(`all notion map roots failed: ${failed[0]?.reason ?? "unknown"}`);
    return {
      docs,
      full: false,
      cursor: null,
      // マップに残ったページの断片だけを残す (除外になった・消えた・起点から外れたページの断片を消す)
      retainDocKeys: deps.repo.pages().map((p) => `notion:${p.page_id}`),
    };
  };

  return Object.assign(collect, { lastReport: () => report });
}
