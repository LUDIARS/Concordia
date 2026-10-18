/**
 * 巡回チャットの知識の組み立て (composition root から呼ぶ adapter 配線、 spec/feature/patrol-chat.md「知識」)。
 *
 * - 取り込み器: LUDIARS 内部 (プロジェクト一覧 + README / spec の先頭)、 Revisor のマージ済み PR、 Notion
 * - 断片の置き場: Cc の DB (chat_knowledge_chunks)
 * - 生成のたびの選択は DB の断片だけを読む (外へ取りに行かない。 生成の 30 秒上限を守る)
 */

import { open, readdir } from "node:fs/promises";
import type Database from "better-sqlite3";
import { ChatKnowledgeRepo } from "../db/chat-knowledge-repo.js";
import { createKnowledgeIngest, type KnowledgeIngest } from "./knowledge-ingest.js";
import { createLudiarsCollector, type KnowledgeProject } from "./knowledge-ludiars.js";
import { createNotionCollector } from "./knowledge-notion.js";
import { createRevisorCollector, type MergedPr } from "./knowledge-revisor.js";
import { selectKnowledge, type KnowledgeQuery } from "./knowledge-select.js";
import type { KnowledgeChunk } from "./knowledge-types.js";

export interface KnowledgeRuntime {
  repo: ChatKnowledgeRepo;
  ingest: KnowledgeIngest;
  select(query: KnowledgeQuery): KnowledgeChunk[];
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
  notionToken: () => string | null;
  /** Revisor のマージ済み PR。 未注入なら revisor の取り込みは配線しない。 */
  mergedPrs?: ((sinceMs: number) => Promise<MergedPr[]>) | null;
  confidentialTerms: () => Promise<string[]>;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  log?: { warn: (msg: string) => void };
}): KnowledgeRuntime {
  const repo = new ChatKnowledgeRepo(deps.db);
  const nowMs = deps.nowMs ?? (() => Date.now());
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
      notion: createNotionCollector({ token: deps.notionToken, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), nowMs }),
    },
    confidentialTerms: deps.confidentialTerms,
    secrets: () => [deps.notionToken()],
    nowMs,
    ...(deps.log ? { log: deps.log } : {}),
  });
  return {
    repo,
    ingest,
    select: (query) => selectKnowledge(repo.list({ publicOnly: !query.allowHq }), query).map((s) => s.chunk),
  };
}
