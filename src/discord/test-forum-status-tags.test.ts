import { describe, expect, it } from "vitest";
import {
  desiredTestForumStatusTags,
  reconcileTestForumTagIds,
} from "./test-forum-status-tags.js";

const tags = [
  { id: "reviewing", name: "審査中" },
  { id: "failed", name: "審査失敗" },
  { id: "human", name: "人間判断" },
  { id: "merge", name: "マージOK" },
  { id: "test", name: "テストOK" },
  { id: "manual", name: "担当A" },
];

describe("Test Forum status tags", () => {
  it("distinguishes Test OK from a mergeable Test OK", () => {
    expect(desiredTestForumStatusTags("test_ok", false)).toEqual(["テストOK"]);
    expect(desiredTestForumStatusTags("test_ok", true)).toEqual(["テストOK", "マージOK"]);
  });

  it("maps terminal states and preserves tags outside Cc ownership", () => {
    expect(reconcileTestForumTagIds(tags, ["manual", "reviewing"], "failed", false))
      .toEqual(["manual", "failed"]);
    expect(reconcileTestForumTagIds(tags, ["manual", "failed"], "action_required", false))
      .toEqual(["manual", "human"]);
  });
});
