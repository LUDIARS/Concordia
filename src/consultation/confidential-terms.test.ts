import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfidentialTerms } from "./confidential-terms.js";

describe("loadConfidentialTerms", () => {
  it("辞書の value だけを返す (架空の語で確認する)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-terms-"));
    const path = join(dir, "terms.json");
    writeFileSync(path, JSON.stringify({ keywords: [{ id: "t1", value: " FictionalTitle ", match: "word" }, { id: "t2", value: "" }] }));
    expect(await loadConfidentialTerms(path)).toEqual(["FictionalTitle"]);
  });

  it("無い・壊れている辞書は空 (呼び出し側はプロジェクト名だけで調べる)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-terms-"));
    expect(await loadConfidentialTerms(join(dir, "missing.json"))).toEqual([]);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{");
    expect(await loadConfidentialTerms(broken)).toEqual([]);
  });
});
