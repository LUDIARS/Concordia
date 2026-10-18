/**
 * 巡回チャットの知識の組み立て (composition root から呼ぶ adapter 配線、 spec/feature/patrol-chat.md「知識」)。
 *
 * - 取り込み器: LUDIARS 内部 (プロジェクト一覧 + README / spec の先頭)、 Revisor のマージ済み PR、 Notion 記事マップ (決まった起点のクロール)
 * - 断片の置き場: Cc の DB (chat_knowledge_chunks)。 記事マップのページ・辺・まとめは notion_map_*
 * - 生成のたびの選択は DB の断片だけを読む (外へ取りに行かない。 生成の 30 秒上限を守る)。 引いた Notion のページの隣も補助的に足す
 * - 記事マップの解析 (要約・キーワード・起点のまとめ) は定期処理のたびに少しずつ進める (notion-map-analyze.ts)
 * - 本社の相談の開始時の文脈に記事マップの概観・まとめ・ページ一覧を添える (notion-map-consult.ts)
 */

import { open, readdir } from "node:fs/promises";
import type Database from "better-sqlite3";
import { ChatKnowledgeRepo } from "../db/chat-knowledge-repo.js";
import { NotionMapRepo } from "../db/notion-map-repo.js";
import { NotionMapRootsRepo } from "../db/notion-map-roots-repo.js";
import { createKnowledgeIngest, redactReason, type KnowledgeIngest } from "./knowledge-ingest.js";
import { createLudiarsCollector, type KnowledgeProject } from "./knowledge-ludiars.js";
import { createRevisorCollector, type MergedPr } from "./knowledge-revisor.js";
import { selectKnowledge, type KnowledgeQuery } from "./knowledge-select.js";
import type { KnowledgeChunk } from "./knowledge-types.js";
import { notionPageIdOf, withNeighborPages } from "./knowledge-usage.js";
import { createNotionMapAnalyzer, type NotionMapAnalyzer } from "./notion-map-analyze.js";
import { buildConsultNotionMapContext } from "./notion-map-consult.js";
import { createNotionMapCollector } from "./notion-map-crawl.js";
import { excludeWords, parseRoots } from "./notion-map-rules.js";
import { NOTION_MAP_DEFAULT_LIMITS, type NotionMapLimits } from "./notion-map-types.js";
import { createMcpNotionSource, type NotionToolRunner } from "./notion-source-mcp.js";
import { createPublicNotionSource } from "./notion-source-public.js";
import { createRoutedNotionSource } from "./notion-source-route.js";
import { NotionSourceUnavailable, type NotionPageSource } from "./notion-source-types.js";
import type { OneShotRunner } from "./render-patrol.js";

/** /rules の「知識」に出す Notion の起点ごとの状態 (秘密値は含まない)。 */
export interface NotionRootStatus {
  root_id: string;
  title: string | null;
  pages: number;
  excluded: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  has_summary: boolean;
  pending_analyses: number;
}

export interface KnowledgeRuntime {
  repo: ChatKnowledgeRepo;
  map: NotionMapRepo;
  mapRoots: NotionMapRootsRepo;
  ingest: KnowledgeIngest;
  /** 記事マップの解析 (runner 未注入なら null)。 */
  analyzer: NotionMapAnalyzer | null;
  select(query: KnowledgeQuery): KnowledgeChunk[];
  /** 起点ごとの状態 (設定の起点の順)。 */
  notionRoots(): NotionRootStatus[];
  /** 本社の相談に添える社内資料の地図 (マップが空なら null)。 */
  consultContext(): string | null;
}

/** ファイルの先頭 maxBytes だけを読む (README / spec を丸ごと読まない)。 */
export async function readFileHead(path: string, maxBytes: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8").replace(/�+$/, "");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** ディレクトリ直下の .md の名前 (下位ディレクトリは辿らない)。 */
export async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md")).map((e) => e.name);
  } catch {
    return [];
  }
}

/** 設定の string-list (保存形は JSON 配列) を読む。 読めなければ空。 */
export function parseStringListSetting(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
  } catch {
    return raw.split(/[\n,]/).map((v) => v.trim()).filter(Boolean);
  }
}

/** 知識の定期取り込みを回す間隔 (期日の判定は ingest.tick が種類ごとに行う)。 */
export const KNOWLEDGE_TICK_MS = 10 * 60 * 1000;

export function buildKnowledgeRuntime(deps: {
  db: Database.Database;
  projects: () => KnowledgeProject[];
  publicProjects: () => string[];
  /** Revisor のマージ済み PR。 未注入なら revisor の取り込みは配線しない。 */
  mergedPrs?: ((sinceMs: number) => Promise<MergedPr[]>) | null;
  confidentialTerms: () => Promise<string[]>;
  /** 記事マップの起点 (設定の行。 未設定なら既定の起点)。 */
  notionRoots?: () => string[] | null;
  /** 除外語の追加 (設定)。 */
  notionExcludes?: () => string[];
  /** 深さ・ページ数・本文バイトの上限 (設定。 未設定の項目は既定値)。 */
  notionLimits?: () => Partial<NotionMapLimits>;
  /** 要約・まとめを作る one-shot runner (haiku)。 未注入なら解析しない (題・本文の断片だけ)。 */
  runner?: OneShotRunner | null;
  /** Notion の読み取りツールだけを許した claude -p (MCP 経路)。 未注入なら MCP 経路は「未設定」。 */
  notionRunner?: NotionToolRunner | null;
  /** Notion のページの取得経路の差し替え (テスト用)。 未注入なら公開ページのクロール → MCP。 */
  notionSource?: NotionPageSource | null;
  /** 公開ページのクロールの fetch。 */
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  log?: { warn: (msg: string) => void };
}): KnowledgeRuntime {
  const repo = new ChatKnowledgeRepo(deps.db);
  const map = new NotionMapRepo(deps.db);
  const mapRoots = new NotionMapRootsRepo(deps.db);
  const nowMs = deps.nowMs ?? (() => Date.now());
  const roots = () => parseRoots(deps.notionRoots?.() ?? null);
  const rootIds = () => roots().map((r) => r.id);
  const unavailableMcp: NotionPageSource = {
    fetchPage: async () => { throw new NotionSourceUnavailable("notion connector runner is not wired"); },
  };
  const source = deps.notionSource ?? createRoutedNotionSource({
    public: createPublicNotionSource(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    mcp: deps.notionRunner ? createMcpNotionSource({ runner: deps.notionRunner }) : unavailableMcp,
  });
  const limits = (): NotionMapLimits => {
    const set = deps.notionLimits?.() ?? {};
    const pick = (v: number | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : d);
    return {
      maxDepth: pick(set.maxDepth, NOTION_MAP_DEFAULT_LIMITS.maxDepth),
      maxPages: pick(set.maxPages, NOTION_MAP_DEFAULT_LIMITS.maxPages),
      pageTextBytes: pick(set.pageTextBytes, NOTION_MAP_DEFAULT_LIMITS.pageTextBytes),
    };
  };
  const notion = createNotionMapCollector({
    source,
    repo: map,
    rootStates: mapRoots,
    roots,
    excludes: () => excludeWords(deps.notionExcludes?.() ?? []),
    limits,
    confidentialTerms: deps.confidentialTerms,
    nowMs,
    ...(deps.log ? { log: deps.log } : {}),
  });
  const ingest = createKnowledgeIngest({
    repo,
    collectors: {
      ludiars: createLudiarsCollector({
        projects: deps.projects,
        publicProjects: deps.publicProjects,
        readHead: readFileHead,
        listMarkdown: listMarkdownFiles,
      }),
      ...(deps.mergedPrs
        ? { revisor: createRevisorCollector({ mergedPrs: deps.mergedPrs, projects: deps.projects, publicProjects: deps.publicProjects, nowMs }) }
        : {}),
      notion,
    },
    confidentialTerms: deps.confidentialTerms,
    nowMs,
    ...(deps.log ? { log: deps.log } : {}),
  });
  const select = (query: KnowledgeQuery): KnowledgeChunk[] => {
    const picked = selectKnowledge(repo.list({ publicOnly: !query.allowHq }), query).map((s) => s.chunk);
    // Notion のページは hq なので、 隣のページを足すのは hq を使える宛先だけ
    if (!query.allowHq) return picked;
    const pageIds = picked.map((c) => notionPageIdOf(c.doc_key)).filter((id): id is string => id !== null);
    if (pageIds.length === 0) return picked;
    const neighbors = repo.leadChunks(map.neighbors(pageIds).map((id) => `notion:${id}`));
    return withNeighborPages(picked, neighbors, {
      allowHq: query.allowHq,
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.maxBytes !== undefined ? { maxBytes: query.maxBytes } : {}),
    });
  };
  const notionRoots = (): NotionRootStatus[] => {
    const states = new Map(mapRoots.roots().map((r) => [r.root_id, r]));
    const pages = map.pages();
    return rootIds().map((rootId) => {
      const r = states.get(rootId);
      return {
        root_id: rootId,
        title: r?.title ?? null,
        pages: r?.pages ?? 0,
        excluded: r?.excluded ?? 0,
        last_attempt_at: r?.last_attempt_at ?? null,
        last_success_at: r?.last_success_at ?? null,
        last_error: r?.last_error ? redactReason(r.last_error, []) : null,
        has_summary: Boolean(r?.summary),
        pending_analyses: pages.filter((p) => p.root_id === rootId && p.analysis_pending).length,
      };
    });
  };
  const consultContext = (): string | null => {
    const ids = rootIds();
    const states = new Map(mapRoots.roots().map((r) => [r.root_id, r]));
    return buildConsultNotionMapContext({
      overview: mapRoots.overview(),
      roots: ids.map((id) => states.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined && r.pages > 0),
      pages: map.pages().filter((p) => ids.includes(p.root_id)),
    });
  };
  return {
    repo,
    map,
    mapRoots,
    ingest,
    analyzer: deps.runner ? createNotionMapAnalyzer({ repo: map, roots: mapRoots, knowledge: repo, runner: deps.runner, nowMs, ...(deps.log ? { log: deps.log } : {}) }) : null,
    select,
    notionRoots,
    consultContext,
  };
}
