import { describe, expect, it } from "vitest";
import { composeNotice } from "./model.js";

const article = { page_id: "3d839cbfbab98174bb4ef6787481efc9", title: "アイデンティティを見つけろ",
  url: "https://candle-stoplight-544.notion.site/3d839cbfbab98174bb4ef6787481efc9" };

describe("AI note notice body", () => {
  it("puts the title and the link on their own lines after a blank line", () => {
    expect(composeNotice(article)).toBe([
      "AI記事を作成しました",
      "",
      article.title,
      article.url,
    ].join("\n"));
  });
});
