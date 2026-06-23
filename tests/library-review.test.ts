import { describe, it, expect } from "vitest";
import { reviewSnapshot, THRESHOLDS } from "../src/library/review.js";
import type { LibrarySource, LibraryBlock } from "../src/library/types.js";

const NOW = 1_700_000_000;

function memBlock(name: string, over: Partial<LibraryBlock> = {}): LibraryBlock {
  return {
    id: `mem:test::${name}`,
    sourceId: "mem:test",
    kind: "memory",
    name,
    title: name,
    description: "",
    relPath: name,
    size_bytes: 500,
    line_count: 10,
    mtime: NOW - 1000,
    flags: {},
    indexLine: `- [${name}](${name}) — hook`,
    ...over,
  };
}

function memSource(blocks: LibraryBlock[], over: Partial<LibrarySource> = {}): LibrarySource {
  return {
    id: "mem:test",
    kind: "memory",
    sourceKind: "central-memory",
    label: "test (central)",
    rootDir: "/tmp/mem",
    indexPath: "/tmp/mem/MEMORY.md",
    indexLineCount: 10,
    indexBytes: 1000,
    blocks,
    ...over,
  };
}

describe("reviewSnapshot", () => {
  it("warns on oversized MEMORY.md index", () => {
    const src = memSource([memBlock("a.md")], {
      indexLineCount: THRESHOLDS.memoryIndexMaxLines + 50,
      indexBytes: THRESHOLDS.memoryIndexMaxBytes + 5000,
    });
    const snap = reviewSnapshot([src], NOW);
    const codes = snap.findings.map((f) => f.code);
    expect(codes).toContain("memory-index-oversize-lines");
    expect(codes).toContain("memory-index-oversize-bytes");
  });

  it("warns when block count exceeds limit", () => {
    const blocks = Array.from({ length: THRESHOLDS.memoryBlocksWarn + 1 }, (_, i) =>
      memBlock(`b${i}.md`),
    );
    const snap = reviewSnapshot([memSource(blocks)], NOW);
    expect(snap.findings.some((f) => f.code === "too-many-blocks")).toBe(true);
  });

  it("flags duplicate names", () => {
    const src = memSource([memBlock("dup.md"), memBlock("dup.md")]);
    const snap = reviewSnapshot([src], NOW);
    expect(src.blocks.every((b) => b.flags.duplicateName)).toBe(true);
  });

  it("flags orphan-file (memory file with no index line) and orphan-index", () => {
    const noIndex = memBlock("loose.md", { indexLine: undefined });
    const orphanIndex = memBlock("gone.md", { flags: { orphanIndex: true }, size_bytes: 0, line_count: 0, mtime: 0 });
    const src = memSource([noIndex, orphanIndex]);
    const snap = reviewSnapshot([src], NOW);
    expect(noIndex.flags.orphanFile).toBe(true);
    expect(snap.findings.some((f) => f.code === "orphan-index")).toBe(true);
    // orphan-index は summary の block 数に数えない。
    expect(snap.summary.memoryBlocks).toBe(1);
  });

  it("flags stale blocks past the threshold", () => {
    const old = memBlock("old.md", { mtime: NOW - (THRESHOLDS.staleDays + 1) * 86400 });
    const src = memSource([old]);
    reviewSnapshot([src], NOW);
    expect(old.flags.stale).toBe(true);
  });

  it("flags oversize memory file", () => {
    const big = memBlock("big.md", { size_bytes: THRESHOLDS.memoryFileMaxBytes + 1 });
    const src = memSource([big]);
    const snap = reviewSnapshot([src], NOW);
    expect(big.flags.oversize).toBe(true);
    expect(snap.findings.some((f) => f.code === "block-oversize")).toBe(true);
  });
});
