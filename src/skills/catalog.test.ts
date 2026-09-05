import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  firstSentence,
  isSafeSkillName,
  parseRwfBindings,
  parseSkillDocument,
  readSkillBody,
  scanSkillCatalog,
  skillCatalogRoots,
  skillDocumentBody,
} from "./catalog.js";

const SKILL_MD = `---
name: domain-review
description: "UX とコアドメインの LLM インタラクティブレビュー。起動語は「ドメインレビュー」。"
metadata:
  type: workflow
  rwf:
    - emoji: ["📑"]
      action: domain-report
      args: "--report-only"
      mode: headless
      model: sonnet
      cwd: repo
    - emoji: ["🪬"]
      action: domain-review
      mode: inject
      model: opus
      cwd: repo
---

# ドメインレビュー (domain-review)

本文の 1 行目。
`;

const COMMAND_MD = `---
name: impl
description: "仕様を確認して処理フローに従い実装する。引数は実装対象のクラス名。"
argument-hint: "<実装対象のクラス名>"
metadata:
  type: workflow
  rwf:
    emoji: ["👍", "🆗"]
    action: start-impl
    mode: inject
    cwd: repo
---

# 実装コマンド
`;

const NO_FRONTMATTER_MD = `# 旧式のコマンド

frontmatter を持たない古いファイル。
`;

describe("parseSkillDocument", () => {
  it("frontmatter から name / description / rwf を読む (rwf が配列)", () => {
    const parsed = parseSkillDocument(SKILL_MD, "fallback");
    expect(parsed.name).toBe("domain-review");
    expect(parsed.description).toBe("UX とコアドメインの LLM インタラクティブレビュー。");
    expect(parsed.rwf).toHaveLength(2);
    expect(parsed.rwf[0]).toEqual({
      emoji: ["📑"], action: "domain-report", args: "--report-only",
      mode: "headless", model: "sonnet", cwd: "repo",
    });
    expect(parsed.rwf[1].mode).toBe("inject");
  });

  it("rwf がオブジェクト 1 個でも 1 要素の配列として読む", () => {
    const parsed = parseSkillDocument(COMMAND_MD, "impl");
    expect(parsed.rwf).toHaveLength(1);
    expect(parsed.rwf[0].emoji).toEqual(["👍", "🆗"]);
    expect(parsed.rwf[0].action).toBe("start-impl");
    expect(parsed.rwf[0].model).toBeNull();
  });

  it("frontmatter が無ければ先頭見出しを description の代わりに使う", () => {
    const parsed = parseSkillDocument(NO_FRONTMATTER_MD, "legacy");
    expect(parsed.name).toBe("legacy");
    expect(parsed.description).toBe("旧式のコマンド");
    expect(parsed.rwf).toEqual([]);
  });

  it("frontmatter が壊れていても一覧から落とさない", () => {
    const parsed = parseSkillDocument("---\n: : :\n---\n\n# 壊れた\n", "broken");
    expect(parsed.name).toBe("broken");
    expect(parsed.description).toBe("壊れた");
  });

  it("本文だけを取り出せる (headless に渡す資料)", () => {
    expect(skillDocumentBody(SKILL_MD)).toContain("# ドメインレビュー");
    expect(skillDocumentBody(SKILL_MD)).not.toContain("metadata:");
  });
});

describe("firstSentence", () => {
  it("句点で切る", () => {
    expect(firstSentence("最初の文。次の文。")).toBe("最初の文。");
  });
  it("英文はピリオドで切る", () => {
    expect(firstSentence("First sentence. Second one.")).toBe("First sentence.");
  });
  it("区切りが無ければ全文", () => {
    expect(firstSentence("  区切りなし  ")).toBe("区切りなし");
  });
});

describe("parseRwfBindings", () => {
  it("emoji が無い宣言は捨てる", () => {
    expect(parseRwfBindings({ action: "context", mode: "inject" })).toEqual([]);
  });
  it("mode 未指定は inject 扱い", () => {
    expect(parseRwfBindings({ emoji: ["🧠"] })[0].mode).toBe("inject");
  });
  it("emoji が文字列 1 個でも受ける", () => {
    expect(parseRwfBindings({ emoji: "🧠" })[0].emoji).toEqual(["🧠"]);
  });
});

describe("isSafeSkillName (パス traversal を許さない)", () => {
  it.each([["..", false], ["../etc", false], ["a/b", false], ["a\\b", false], [".hidden", false], ["domain-review", true]])(
    "%s → %s",
    (name, expected) => {
      expect(isSafeSkillName(name as string)).toBe(expected);
    },
  );
});

describe("skillCatalogRoots", () => {
  it("Castra の skills / commands と user 領域を返す", () => {
    const roots = skillCatalogRoots("E:/Document/Ars");
    expect(roots.map((r) => r.source)).toEqual(["skills", "commands", "user"]);
    expect(roots[0].dir.replace(/\\/g, "/")).toBe("E:/Document/Ars/.claude/skills");
    expect(roots[1].dir.replace(/\\/g, "/")).toBe("E:/Document/Ars/.claude/commands");
  });
});

describe("scanSkillCatalog", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "concordia-skill-catalog-"));
    await mkdir(join(root, ".claude", "skills", "domain-review"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "domain-review", "SKILL.md"), SKILL_MD, "utf-8");
    // SKILL.md を持たないディレクトリは対象外 (README 置き場)。
    await mkdir(join(root, ".claude", "skills", "not-a-skill"), { recursive: true });
    await mkdir(join(root, ".claude", "commands"), { recursive: true });
    await writeFile(join(root, ".claude", "commands", "impl.md"), COMMAND_MD, "utf-8");
    await writeFile(
      join(root, ".claude", "commands", "domain-review.md"),
      COMMAND_MD.replace("name: impl", "name: domain-review"),
      "utf-8",
    );
    await writeFile(join(root, ".claude", "commands", "legacy.md"), NO_FRONTMATTER_MD, "utf-8");
    await writeFile(join(root, ".claude", "commands", "notes.txt"), "ignored", "utf-8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("skills と commands の両方を同じパーサで拾う", async () => {
    const catalog = await scanSkillCatalog(root, { now: () => 42 });
    const byName = (name: string) => catalog.entries.find((entry) => entry.name === name);
    expect(byName("domain-review")?.source).toBe("skills");
    expect(byName("impl")?.source).toBe("commands");
    expect(byName("legacy")?.description).toBe("旧式のコマンド");
    expect(byName("not-a-skill")).toBeUndefined();
    expect(byName("notes")).toBeUndefined();
    expect(catalog.scannedAt).toBe(42);
  });

  it("rwf 宣言をそのまま持ち帰る", async () => {
    const catalog = await scanSkillCatalog(root);
    const review = catalog.entries.find((e) => e.name === "domain-review");
    expect(review?.rwf.map((b) => b.emoji[0])).toEqual(["📑", "🪬"]);
  });

  it("同名なら workspace skill を command より先に置く", async () => {
    const catalog = await scanSkillCatalog(root);
    expect(catalog.entries.filter((entry) => entry.name === "domain-review").map((entry) => entry.source))
      .toEqual(["skills", "commands"]);
  });

  it("本文はカタログのエントリ経由でのみ読む", async () => {
    const catalog = await scanSkillCatalog(root);
    const review = catalog.entries.find((e) => e.name === "domain-review")!;
    const body = await readSkillBody(review);
    expect(body).toContain("本文の 1 行目。");
    expect(body).not.toContain("metadata:");
  });

  it("`.claude/` が無いルートでも落ちない", async () => {
    const empty = await mkdtemp(join(tmpdir(), "concordia-skill-empty-"));
    try {
      const catalog = await scanSkillCatalog(empty);
      expect(catalog.entries.filter((e) => e.source !== "user")).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
