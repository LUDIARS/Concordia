/**
 * 決定的レビュー (純粋・LLM 不使用)。
 *
 * scanner が組んだ source/block 群に対し、 閾値判定 / orphan / 重複 / 陳腐化 を計算して
 * block.flags を埋め、 source 横断の所見 (ReviewFinding) と summary を付けた
 * LibrarySnapshot を返す。 入力 source 配列は in-place で flags が補われる
 * (リクエスト毎に scanner が新規生成する前提)。
 */

import type {
  LibrarySource,
  LibrarySnapshot,
  ReviewFinding,
  LibraryBlock,
} from "./types.js";

/** 閾値 (1 箇所に集約)。 */
export const THRESHOLDS = {
  /** MEMORY.md index の行数警告。 */
  memoryIndexMaxLines: 200,
  /** MEMORY.md index のバイト数警告。 */
  memoryIndexMaxBytes: 40_000,
  /** index 1 行の文字数警告 (ハーネス推奨 "~200 字")。 */
  indexLineMaxChars: 200,
  /** メモリ home あたりの block 数警告。 */
  memoryBlocksWarn: 80,
  /** スキル root あたりの block 数警告。 */
  skillBlocksWarn: 40,
  /** 1 メモリファイルのバイト数警告 (topic は小さく保つ)。 */
  memoryFileMaxBytes: 16_000,
  /** スキル中身のバイト数 / 行数警告。 */
  skillMaxBytes: 24_000,
  skillMaxLines: 400,
  /** 陳腐化とみなす経過日数。 */
  staleDays: 180,
} as const;

export function reviewSnapshot(sources: LibrarySource[], now: number): LibrarySnapshot {
  const findings: ReviewFinding[] = [];
  const staleCutoff = now - THRESHOLDS.staleDays * 86400;

  let totalBlocks = 0;
  let totalBytes = 0;
  let memoryBlocks = 0;
  let skillBlocks = 0;

  for (const src of sources) {
    // MEMORY.md index の過多。
    if (src.kind === "memory") {
      if ((src.indexLineCount ?? 0) > THRESHOLDS.memoryIndexMaxLines) {
        findings.push({
          level: "warn",
          code: "memory-index-oversize-lines",
          message: `${src.label} の MEMORY.md が ${src.indexLineCount} 行 (推奨 ${THRESHOLDS.memoryIndexMaxLines} 行以下)。 退避/分割を検討。`,
          sourceId: src.id,
        });
      }
      if ((src.indexBytes ?? 0) > THRESHOLDS.memoryIndexMaxBytes) {
        findings.push({
          level: "warn",
          code: "memory-index-oversize-bytes",
          message: `${src.label} の MEMORY.md が ${fmtKB(src.indexBytes ?? 0)} (推奨 ${fmtKB(THRESHOLDS.memoryIndexMaxBytes)} 以下)。`,
          sourceId: src.id,
        });
      }
    }

    // block 数の過多。
    const limit = src.kind === "memory" ? THRESHOLDS.memoryBlocksWarn : THRESHOLDS.skillBlocksWarn;
    const realCount = src.blocks.filter((b) => !b.flags.orphanIndex).length;
    if (realCount > limit) {
      findings.push({
        level: "warn",
        code: "too-many-blocks",
        message: `${src.label} に ${realCount} 件 (推奨 ${limit} 件以下)。 数が多過ぎます。`,
        sourceId: src.id,
      });
    }

    // 同名重複の検出 (source 内)。
    const byName = new Map<string, LibraryBlock[]>();
    for (const b of src.blocks) {
      const arr = byName.get(b.name);
      if (arr) arr.push(b);
      else byName.set(b.name, [b]);
    }

    for (const b of src.blocks) {
      enrichBlock(b, src, byName, staleCutoff, findings);
      if (!b.flags.orphanIndex) {
        totalBlocks++;
        totalBytes += b.size_bytes;
        if (b.kind === "memory") memoryBlocks++;
        else skillBlocks++;
      }
    }
  }

  return {
    scannedAt: now,
    sources,
    summary: {
      totalSources: sources.length,
      totalBlocks,
      totalBytes,
      memoryBlocks,
      skillBlocks,
    },
    findings,
  };
}

function enrichBlock(
  b: LibraryBlock,
  src: LibrarySource,
  byName: Map<string, LibraryBlock[]>,
  staleCutoff: number,
  findings: ReviewFinding[],
): void {
  // 重複。
  if ((byName.get(b.name)?.length ?? 0) > 1) {
    b.flags.duplicateName = true;
  }

  // orphan-index は scanner が立て済 → 情報所見のみ。
  if (b.flags.orphanIndex) {
    findings.push({
      level: "info",
      code: "orphan-index",
      message: `${src.label}: MEMORY.md に "${b.name}" の行があるが実ファイルが無い。 行のみ退避可。`,
      sourceId: src.id,
      blockId: b.id,
    });
    return; // 以降の size/stale 判定はファイルが無いので対象外。
  }

  // メモリで index 行が無い実ファイル (orphan-file)。
  if (b.kind === "memory" && !b.indexLine) {
    b.flags.orphanFile = true;
    findings.push({
      level: "info",
      code: "orphan-file",
      message: `${src.label}: "${b.name}" は MEMORY.md に index 行が無い。`,
      sourceId: src.id,
      blockId: b.id,
    });
  }

  // index 行が長過ぎる。
  if (b.indexLine && b.indexLine.length > THRESHOLDS.indexLineMaxChars) {
    findings.push({
      level: "info",
      code: "index-line-too-long",
      message: `${src.label}: "${b.name}" の index 行が ${b.indexLine.length} 字 (推奨 ${THRESHOLDS.indexLineMaxChars} 字以下)。`,
      sourceId: src.id,
      blockId: b.id,
    });
  }

  // oversize。
  const overBytes =
    b.kind === "memory"
      ? b.size_bytes > THRESHOLDS.memoryFileMaxBytes
      : b.size_bytes > THRESHOLDS.skillMaxBytes;
  const overLines = b.kind === "skill" && b.line_count > THRESHOLDS.skillMaxLines;
  if (overBytes || overLines) {
    b.flags.oversize = true;
    findings.push({
      level: "warn",
      code: "block-oversize",
      message: `${src.label}: "${b.name}" が ${fmtKB(b.size_bytes)} / ${b.line_count} 行と大きい。`,
      sourceId: src.id,
      blockId: b.id,
    });
  }

  // 陳腐化 (mtime が古い)。
  if (b.mtime > 0 && b.mtime < staleCutoff) {
    b.flags.stale = true;
    findings.push({
      level: "info",
      code: "stale",
      message: `${src.label}: "${b.name}" は ${THRESHOLDS.staleDays} 日以上更新なし。 内容の陳腐化を確認。`,
      sourceId: src.id,
      blockId: b.id,
    });
  }

  // poison (scanner 設定済)。
  if (b.flags.poison && b.flags.poison.length > 0) {
    findings.push({
      level: "warn",
      code: "poison",
      message: `${src.label}: "${b.name}" に注意パターン: ${b.flags.poison.join(" / ")}`,
      sourceId: src.id,
      blockId: b.id,
    });
  }
}

function fmtKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}
