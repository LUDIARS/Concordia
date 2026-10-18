import { describe, expect, it } from "vitest";
import { excludeWords, isExcludedPage, normalizeNotionId, parseRootIds, parseRoots } from "./notion-map-rules.js";
import { NOTION_MAP_DEFAULT_ROOTS } from "./notion-map-types.js";

const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba98-7654-3210-fedc-ba9876543210";

describe("notion map rules", () => {
  it("reads the leading page id or public URL of each line and falls back to the default roots", () => {
    expect(normalizeNotionId(ID_B)).toBe("fedcba9876543210fedcba9876543210");
    expect(parseRootIds([`${ID_A} 例の起点`, ID_B, `${ID_A} 重複`, "名前だけの行"])).toEqual([ID_A, "fedcba9876543210fedcba9876543210"]);
    expect(parseRoots([`https://example.notion.site/Example-Page-${ID_A} 公開の起点`, ID_B])).toEqual([
      { id: ID_A, url: `https://example.notion.site/Example-Page-${ID_A}` },
      { id: "fedcba9876543210fedcba9876543210", url: null },
    ]);
    // 公開ページ以外の URL は URL として持たない (MCP で読む)
    expect(parseRoots([`https://www.notion.so/Example-${ID_A}`])).toEqual([{ id: ID_A, url: null }]);
    expect(parseRootIds(null)).toHaveLength(NOTION_MAP_DEFAULT_ROOTS.length);
    expect(parseRootIds([])).toHaveLength(NOTION_MAP_DEFAULT_ROOTS.length);
  });

  it("excludes pages whose title or path has an exclusion word, including descendants", () => {
    const words = excludeWords(["例の除外語", " ", "チーム"]);
    expect(words).toEqual(["個人ページ", "チーム", "タスクリスト", "チームテンプレート", "例の除外語"]);
    expect(isExcludedPage("個人ページ", "例の学年 > 個人ページ", words)).toBe(true);
    expect(isExcludedPage("例の生徒", "例の学年 > 個人ページ > 例の生徒", words)).toBe(true);
    expect(isExcludedPage("例のチーム", "例の学年 > 例のチーム", words)).toBe(true);
    expect(isExcludedPage("タスクリスト 10 月", "例の学年 > タスクリスト 10 月", words)).toBe(true);
    expect(isExcludedPage("第1回 授業内容", "例の学年 > 授業内容 > 第1回 授業内容", words)).toBe(false);
  });
});
