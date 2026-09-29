import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  buildProjectRulesText,
  collectProjectRules,
  PROJECT_RULES_MAX_CHARS,
  readDeliveredProjectRules,
  selectUndelivered,
} from "./project-rules-inject.js";

const root = "E:/Document/Ars/Concordia";

function reader(files: Record<string, string>) {
  return async (path: string) => files[path] ?? null;
}

describe("collectProjectRules", () => {
  it("reads AGENTS.md and the rule index", async () => {
    const bundle = await collectProjectRules({ code: "Cc", root }, reader({
      [join(root, "AGENTS.md")]: "# Concordia の開発\nDDD で進める。",
      [join(root, "rule", "README.md")]: "# rule 索引",
    }));
    expect(bundle.documents.map((doc) => [doc.label, doc.path])).toEqual([
      ["作業規則", join(root, "AGENTS.md")],
      ["rule 索引", join(root, "rule", "README.md")],
    ]);
    expect(bundle.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to CLAUDE.md and marks missing documents", async () => {
    const bundle = await collectProjectRules({ code: "Ac", root: "E:/x" }, reader({ [join("E:/x", "CLAUDE.md")]: "rules" }));
    expect(bundle.documents[0]).toMatchObject({ path: join("E:/x", "CLAUDE.md"), text: "rules" });
    expect(bundle.documents[1]).toMatchObject({ path: null, text: null });
  });

  it("truncates long documents and changes the hash when content changes", async () => {
    const long = "x".repeat(PROJECT_RULES_MAX_CHARS + 10);
    const a = await collectProjectRules({ code: "Cc", root }, reader({ [join(root, "AGENTS.md")]: long }));
    expect(a.documents[0]).toMatchObject({ truncated: true });
    expect(a.documents[0]!.text).toHaveLength(PROJECT_RULES_MAX_CHARS);
    const b = await collectProjectRules({ code: "Cc", root }, reader({ [join(root, "AGENTS.md")]: "short" }));
    expect(b.hash).not.toBe(a.hash);
  });
});

describe("delivery selection and text", () => {
  it("sends only projects that are new or whose rules changed", async () => {
    const cc = await collectProjectRules({ code: "Cc", root }, reader({ [join(root, "AGENTS.md")]: "a" }));
    const ac = await collectProjectRules({ code: "Ac", root: "E:/Actio" }, reader({}));
    expect(selectUndelivered([cc, ac], { Cc: cc.hash }).map((bundle) => bundle.code)).toEqual(["Ac"]);
    expect(selectUndelivered([cc], { Cc: "old" }).map((bundle) => bundle.code)).toEqual(["Cc"]);
  });

  it("labels the project, keeps the source path and warns about missing documents", async () => {
    const bundle = await collectProjectRules({ code: "Cc", root }, reader({ [join(root, "AGENTS.md")]: "DDD で進める。" }));
    const text = buildProjectRulesText(bundle, "registered");
    expect(text.startsWith(`[Cc project rules] Cc (${root})`)).toBe(true);
    expect(text).toContain("DDD で進める。");
    expect(text).toContain("実行許可を追加しません");
    expect(text).toContain("見つかりません");
    expect(buildProjectRulesText(bundle, "updated")).toContain("更新されました");
  });

  it("reads the delivered map defensively", () => {
    expect(readDeliveredProjectRules(JSON.stringify({ cc_project_rules_delivered: { Cc: "h", bad: 1 } }))).toEqual({ Cc: "h" });
    expect(readDeliveredProjectRules("{broken")).toEqual({});
    expect(readDeliveredProjectRules(null)).toEqual({});
  });
});
