/**
 * /v1/library API — メモリ/スキル整理 (Library Hygiene)。
 *
 * - GET  /v1/library            : スナップショット + 決定的レビュー (LLM 不使用・高速)
 * - GET  /v1/library/content    : block / 退避ファイルの中身 (レビュー用プレビュー)
 * - GET  /v1/library/archived   : ある source の退避済み台帳
 * - POST /v1/library/analyze    : 矛盾検査 + 自動整理サジェスト (claude -p haiku、 提案のみ)
 * - POST /v1/library/archive    : 選択 block の退避 (既定 dry-run、 apply:true で実行)
 * - POST /v1/library/restore    : 退避の復帰
 *
 * 退避は完全削除しない (move + 台帳)。 LLM サジェストは自動適用しない。
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { join } from "node:path";
import { resolveLibraryRoots, LibraryRootsError } from "../library/roots.js";
import { scanLibrary } from "../library/scanner.js";
import { reviewSnapshot } from "../library/review.js";
import { analyzeHome } from "../library/contradictions.js";
import { readBlockContent } from "../library/content.js";
import {
  planArchive,
  applyArchive,
  listArchived,
  restoreArchived,
  type ArchiveTarget,
} from "../library/archive.js";
import type { LibrarySnapshot, LibrarySource, LibraryBlock } from "../library/types.js";

const ARCHIVE_DIRNAME = "_archive";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export interface LibraryApiDeps {
  resolveWorkspaceRoots: () => string[];
}

export function libraryRouter(deps: LibraryApiDeps): Hono {
  const app = new Hono();

  /** 共通: roots 解決 → scan → review。 失敗は fail-fast で投げる。 */
  function snapshot(): LibrarySnapshot {
    const roots = resolveLibraryRoots(deps.resolveWorkspaceRoots());
    const sources = scanLibrary(roots);
    return reviewSnapshot(sources, nowSec());
  }

  app.get("/", (c) => {
    let snap: LibrarySnapshot;
    try {
      snap = snapshot();
    } catch (e) {
      return rootsError(c, e);
    }
    const sourceFilter = c.req.query("source");
    const sources = sourceFilter ? snap.sources.filter((s) => s.id === sourceFilter) : snap.sources;
    return c.json({ ...snap, sources });
  });

  app.get("/content", (c) => {
    const sourceId = c.req.query("source");
    const path = c.req.query("path");
    const archived = c.req.query("archived") === "1" || c.req.query("archived") === "true";
    if (!sourceId || !path) return c.json({ error: "source and path required" }, 400);
    let snap: LibrarySnapshot;
    try {
      snap = snapshot();
    } catch (e) {
      return rootsError(c, e);
    }
    const src = snap.sources.find((s) => s.id === sourceId);
    if (!src) return c.json({ error: "source not found" }, 404);
    const content = readBlockContent(src.rootDir, path, archived);
    if (!content) return c.json({ error: "not found" }, 404);
    return c.json(content);
  });

  app.get("/archived", (c) => {
    const sourceId = c.req.query("source");
    if (!sourceId) return c.json({ error: "source query required" }, 400);
    let snap: LibrarySnapshot;
    try {
      snap = snapshot();
    } catch (e) {
      return rootsError(c, e);
    }
    const src = snap.sources.find((s) => s.id === sourceId);
    if (!src) return c.json({ error: "source not found" }, 404);
    const archived = listArchived(join(src.rootDir, ARCHIVE_DIRNAME));
    return c.json({ source: sourceId, archived });
  });

  const AnalyzeSchema = z.object({ home: z.string().min(1) });
  app.post("/analyze", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AnalyzeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    let snap: LibrarySnapshot;
    try {
      snap = snapshot();
    } catch (e) {
      return rootsError(c, e);
    }
    const src = snap.sources.find((s) => s.id === parsed.data.home);
    if (!src) return c.json({ error: "source not found" }, 404);
    const result = await analyzeHome(src);
    if (result.error) return c.json({ error: "claude_failed", detail: result.error }, 502);
    return c.json(result);
  });

  const BlockRef = z.object({ sourceId: z.string().min(1), name: z.string().min(1) });
  const ArchiveSchema = z.object({
    blocks: z.array(BlockRef).min(1),
    apply: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  });
  app.post("/archive", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ArchiveSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    let snap: LibrarySnapshot;
    try {
      snap = snapshot();
    } catch (e) {
      return rootsError(c, e);
    }
    const targets: ArchiveTarget[] = [];
    const notFound: Array<{ sourceId: string; name: string }> = [];
    for (const ref of parsed.data.blocks) {
      const t = buildTarget(snap, ref.sourceId, ref.name, parsed.data.reason);
      if (t) targets.push(t);
      else notFound.push(ref);
    }
    if (targets.length === 0) {
      return c.json({ error: "no resolvable blocks", notFound }, 404);
    }
    const apply = parsed.data.apply === true;
    if (apply) {
      const result = applyArchive(targets, nowSec());
      return c.json({ ...result, notFound });
    }
    return c.json({ applied: false, items: planArchive(targets), notFound });
  });

  const RestoreSchema = z.object({
    blocks: z.array(z.object({ sourceId: z.string().min(1), blockId: z.string().min(1) })).min(1),
  });
  app.post("/restore", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RestoreSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    let snap: LibrarySnapshot;
    try {
      snap = snapshot();
    } catch (e) {
      return rootsError(c, e);
    }
    const results = parsed.data.blocks.map((ref) => {
      const src = snap.sources.find((s) => s.id === ref.sourceId);
      if (!src) return { ok: false, name: ref.blockId, restoredTo: null, indexLineRestored: false, warnings: ["source not found"] };
      return restoreArchived(join(src.rootDir, ARCHIVE_DIRNAME), ref.blockId, nowSec());
    });
    return c.json({ results });
  });

  return app;
}

/** snapshot から block を引き、 archive 操作用の ArchiveTarget を組み立てる。 */
function buildTarget(
  snap: LibrarySnapshot,
  sourceId: string,
  name: string,
  reason: string | undefined,
): ArchiveTarget | null {
  const src: LibrarySource | undefined = snap.sources.find((s) => s.id === sourceId);
  if (!src) return null;
  const block: LibraryBlock | undefined = src.blocks.find((b) => b.name === name);
  if (!block) return null;
  return {
    blockId: block.id,
    name: block.name,
    kind: block.kind,
    absPath: join(src.rootDir, block.relPath),
    archiveDir: join(src.rootDir, ARCHIVE_DIRNAME),
    relPath: block.relPath,
    indexPath: src.indexPath,
    indexLine: block.indexLine,
    orphanIndex: block.flags.orphanIndex,
    reason,
  };
}

function rootsError(c: Context, e: unknown) {
  if (e instanceof LibraryRootsError) {
    return c.json({ error: "library_roots_unresolved", detail: e.message }, 500);
  }
  throw e;
}
