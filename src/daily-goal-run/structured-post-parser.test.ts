import { describe, expect, it } from "vitest";
import { isStructuredPost, parsePermissionWords, parseStructuredPost } from "./structured-post-parser.js";

const post = [
  "プロジェクト: Cc",
  "ゴール: デイリーゴールの投稿登録を出荷する",
  "受入条件:",
  "- PR がマージされる",
  "- Cc で反映を確認",
  "許可: テスト, マージ",
  "task: actio:t-1 t-2",
].join("\n");

describe("structured post (LLM を通さず読む)", () => {
  it("detects the format by its key lines", () => {
    expect(isStructuredPost(post)).toBe(true);
    expect(isStructuredPost("今日は Cc のバグを直す")).toBe(false);
  });

  it("reads every field and quotes the post itself", () => {
    expect(parseStructuredPost(post)).toEqual({
      project: "Cc",
      goalText: "デイリーゴールの投稿登録を出荷する",
      acceptance: ["PR がマージされる", "Cc で反映を確認"],
      permissions: { merge: true, test: true, service: false, deploy: false },
      actioTaskIds: ["t-1", "t-2"],
      quotes: {
        project: "Cc", goalText: "デイリーゴールの投稿登録を出荷する",
        "acceptance.0": "PR がマージされる", "acceptance.1": "Cc で反映を確認",
        "permissions.merge": "テスト, マージ", "permissions.test": "テスト, マージ",
      },
    });
  });

  it("leaves missing fields empty and denies every permission by default", () => {
    expect(parseStructuredPost("ゴール: 調査する")).toMatchObject({ goalText: "調査する", acceptance: [], actioTaskIds: [],
      permissions: { merge: false, test: false, service: false, deploy: false } });
    expect(parsePermissionWords("なし")).toEqual({ merge: false, test: false, service: false, deploy: false });
    expect(parseStructuredPost("受入条件: A; B")).toMatchObject({ acceptance: ["A", "B"] });
  });
});
