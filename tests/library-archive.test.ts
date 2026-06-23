import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  planArchive,
  applyArchive,
  listArchived,
  restoreArchived,
  removeIndexLine,
  type ArchiveTarget,
} from "../src/library/archive.js";
import { makeTestDir } from "./helpers/db.js";

const NOW = 1_700_000_000;

function setupMemoryHome(): { dir: string; indexPath: string; fileName: string; indexLine: string } {
  const dir = makeTestDir("concordia-library-");
  const fileName = "feedback_foo.md";
  // CRLF を混ぜて、 行削除が他行の改行コードを壊さないことを検証する。
  const indexLine = "- [Foo](feedback_foo.md) — フック";
  const indexPath = join(dir, "MEMORY.md");
  writeFileSync(
    indexPath,
    ["# MEMORY", "", "- [Bar](bar.md) — 別の行", indexLine, "- [Baz](baz.md) — もう一つ"].join("\r\n"),
    "utf-8",
  );
  writeFileSync(join(dir, fileName), "---\nname: foo\n---\n本文", "utf-8");
  return { dir, indexPath, fileName, indexLine };
}

function target(dir: string, fileName: string, indexPath: string, indexLine: string): ArchiveTarget {
  return {
    blockId: `mem:t::${fileName}`,
    name: fileName,
    kind: "memory",
    absPath: join(dir, fileName),
    archiveDir: join(dir, "_archive"),
    relPath: fileName,
    indexPath,
    indexLine,
  };
}

describe("removeIndexLine", () => {
  it("removes the matching line and preserves surrounding CRLF", () => {
    const raw = "a\r\n- [Foo](feedback_foo.md) — フック\r\nb\r\n";
    const { content, removed } = removeIndexLine(raw, "- [Foo](feedback_foo.md) — フック");
    expect(removed).toBe(true);
    expect(content).toBe("a\r\nb\r\n");
  });

  it("returns removed=false when line not present", () => {
    const { removed } = removeIndexLine("a\nb\n", "- [X](x.md)");
    expect(removed).toBe(false);
  });
});

describe("archive dry-run vs apply", () => {
  it("planArchive does not touch the filesystem", () => {
    const { dir, indexPath, fileName, indexLine } = setupMemoryHome();
    const plan = planArchive([target(dir, fileName, indexPath, indexLine)]);
    expect(plan[0]).toMatchObject({ action: "move-and-deindex", ok: true });
    // ファイルは元のまま、 _archive も無い。
    expect(existsSync(join(dir, fileName))).toBe(true);
    expect(existsSync(join(dir, "_archive"))).toBe(false);
  });

  it("applyArchive moves the file, de-indexes (CRLF preserved), and writes the ledger", () => {
    const { dir, indexPath, fileName, indexLine } = setupMemoryHome();
    const result = applyArchive([target(dir, fileName, indexPath, indexLine)], NOW);
    expect(result.applied).toBe(true);
    expect(result.items[0].ok).toBe(true);
    expect(result.items[0].indexLineRemoved).toBe(true);

    // ファイルが _archive へ移動。
    expect(existsSync(join(dir, fileName))).toBe(false);
    expect(existsSync(join(dir, "_archive", fileName))).toBe(true);

    // MEMORY.md から該当行のみ消え、 他行の CRLF は保たれる。
    const idx = readFileSync(indexPath, "utf-8");
    expect(idx).not.toContain("feedback_foo.md");
    expect(idx).toContain("- [Bar](bar.md)");
    expect(idx).toContain("\r\n");

    // 台帳。
    expect(existsSync(join(dir, "_archive", "ledger.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "_archive", "ARCHIVE.md"))).toBe(true);
    const archived = listArchived(join(dir, "_archive"));
    expect(archived).toHaveLength(1);
    expect(archived[0].name).toBe(fileName);
  });

  it("warns instead of overwriting when the archive destination exists", () => {
    const { dir, indexPath, fileName, indexLine } = setupMemoryHome();
    mkdirSync(join(dir, "_archive"), { recursive: true });
    writeFileSync(join(dir, "_archive", fileName), "既存", "utf-8");
    const plan = planArchive([target(dir, fileName, indexPath, indexLine)]);
    expect(plan[0].ok).toBe(false);
    expect(plan[0].warnings.join()).toContain("既に存在");
  });
});

describe("restore", () => {
  it("moves the file back and re-adds the index line", () => {
    const { dir, indexPath, fileName, indexLine } = setupMemoryHome();
    const t = target(dir, fileName, indexPath, indexLine);
    applyArchive([t], NOW);
    const r = restoreArchived(join(dir, "_archive"), t.blockId, NOW + 10);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, fileName))).toBe(true);
    expect(readFileSync(indexPath, "utf-8")).toContain("feedback_foo.md");
    // 台帳が空に。
    expect(listArchived(join(dir, "_archive"))).toHaveLength(0);
  });
});
