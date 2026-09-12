import { describe, expect, it } from "vitest";
import { ArticleSchema, TargetsSchema } from "./contract.js";

const article = { page_id: "3d839cbf-bab9-8174-bb4e-f6787481efc9", title: "記事",
  url: "https://app.notion.com/p/3d839cbfbab98174bb4ef6787481efc9" };
describe("AI note input boundary", () => {
  it("canonicalizes the page identity", () => {
    expect(ArticleSchema.parse(article).page_id).toBe("3d839cbfbab98174bb4ef6787481efc9");
  });
  it.each([
    "http://app.notion.com/p/3d839cbfbab98174bb4ef6787481efc9",
    "https://evil.test/3d839cbfbab98174bb4ef6787481efc9",
    "https://app.notion.com/p/3d839cbfbab981ccb360c09358f5d1f3",
    "https://app.notion.com/p/3d839cbfbab98174bb4ef6787481efc9?token=secret",
  ])("rejects mismatched or unsuitable links: %s", url => {
    expect(ArticleSchema.safeParse({ ...article, url }).success).toBe(false);
  });
  it("rejects a 紹介文 because the notice carries only the title and the link", () => {
    expect(ArticleSchema.safeParse({ ...article, summary: "紹介" }).success).toBe(false);
  });
  it("rejects duplicate physical destinations even when their kind differs", () => {
    const common = { guild_id: "111111111111111111", channel_id: "222222222222222222" };
    expect(TargetsSchema.safeParse({ targets: [
      { ...common, kind: "discord-channel" }, { ...common, kind: "discord-forum", applied_tags: [] },
    ] }).success).toBe(false);
  });
});
