import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionLog, readSessionLogs, readSessionLogFull, resolveSessionLogsDir } from "./reader.js";
import { extractProjects } from "./project-dictionary.js";

describe("extractProjects", () => {
  it("picks up project names from headings", () => {
    const text = "# 2026-06-22 セッションログ\n\n## — Anatomia 残タスク消化 / Opus\n本文。";
    expect(extractProjects(text)).toContain("Anatomia");
  });

  it("matches a name immediately followed by Japanese (no space)", () => {
    expect(extractProjects("## Pictor描画の調整\n本文")).toContain("Pictor");
  });

  it("does not tag parent project when only the submodule appears", () => {
    const got = extractProjects("## Actio-PublicModules の予約API\nActio-PublicModules を直した");
    expect(got).toContain("Actio-PublicModules");
    expect(got).not.toContain("Actio");
  });

  it("tags on a single mention (recall over precision)", () => {
    expect(extractProjects("本文で一度だけ Quaestor に触れた")).toContain("Quaestor");
  });

  it("does not tag the ubiquitous Ars / LUDIARS path tokens", () => {
    const text = "# log\nE:/Document/Ars/Memoria を編集 (LUDIARS org)";
    const got = extractProjects(text);
    expect(got).not.toContain("Ars");
    expect(got).not.toContain("LUDIARS");
    expect(got).toContain("Memoria"); // Ars/Memoria のパス内でも拾える
  });
});

describe("parseSessionLog", () => {
  it("extracts id/date/seq/title/sections/excerpt", () => {
    const md = "# 2026-06-26 セッションログ\n\n## スコープ\n- Concordia の RWF を直す\n\n## 学び\n本文テキスト。";
    const meta = parseSessionLog("2026-06-26-2", md, 1000, md.length);
    expect(meta.date).toBe("2026-06-26");
    expect(meta.seq).toBe(2);
    expect(meta.title).toBe("2026-06-26 セッションログ");
    expect(meta.sections).toEqual(["スコープ", "学び"]);
    expect(meta.projects).toContain("Concordia");
    expect(meta.excerpt).toContain("RWF");
  });

  it("falls back to id as title and seq=1 when no h1 / no suffix", () => {
    const meta = parseSessionLog("2026-05-01", "本文のみ", 1, 4);
    expect(meta.seq).toBe(1);
    expect(meta.title).toBe("2026-05-01");
  });
});

describe("readSessionLogs / readSessionLogFull / resolveSessionLogsDir", () => {
  it("reads a dir newest-first and rejects path traversal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sesslog-"));
    try {
      writeFileSync(join(dir, "2026-06-01.md"), "# old\n## a\nPictor Pictor", "utf-8");
      writeFileSync(join(dir, "2026-06-02.md"), "# new\n## b\nMemoria Memoria", "utf-8");
      writeFileSync(join(dir, "notes.txt"), "ignored", "utf-8");

      const list = await readSessionLogs(dir);
      expect(list.map((e) => e.id)).toEqual(["2026-06-02", "2026-06-01"]);

      const full = await readSessionLogFull(dir, "2026-06-02");
      expect(full?.content_md).toContain("Memoria");

      expect(await readSessionLogFull(dir, "../secret")).toBeNull();
      expect(await readSessionLogFull(dir, "missing")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveSessionLogsDir finds <root>/session-logs and returns null otherwise", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      expect(await resolveSessionLogsDir([root])).toBeNull();
      const dir = join(root, "session-logs");
      mkdirSync(dir);
      expect(await resolveSessionLogsDir([root])).toBe(dir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
