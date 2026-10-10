import { describe, expect, it } from "vitest";
import { guardExtraction, normalizeForQuote } from "./extraction-guard.js";
import type { ExtractedGoal } from "./domain.js";

const text = "Cc で投稿登録を出荷したい。PR がマージされたら達成。テストは実行してよい。actio:t-1";
const raw = (patch: Partial<ExtractedGoal> = {}): ExtractedGoal => ({
  project: "Concordia", goalText: "投稿登録を出荷する", acceptance: ["PR がマージされる"],
  permissions: { merge: false, test: true, service: false, deploy: false }, actioTaskIds: ["t-1"],
  quotes: { project: "Cc", goalText: "投稿登録を出荷したい", "acceptance.0": "PR がマージされたら達成", "permissions.test": "テストは実行してよい" },
  ...patch,
});

describe("guardExtraction (CC-DG-INV-09: 本文に根拠のある項目だけを採る)", () => {
  it("keeps fields whose quotes appear in the post", () => {
    expect(guardExtraction(text, raw())).toMatchObject({ dropped: [], extracted: {
      project: "Concordia", acceptance: ["PR がマージされる"], actioTaskIds: ["t-1"], permissions: { test: true },
    } });
  });

  it("drops invented acceptance, permissions and tasks that the post does not contain", () => {
    const result = guardExtraction(text, raw({
      acceptance: ["PR がマージされる", "Ex で反映を確認する"],
      permissions: { merge: true, test: true, service: false, deploy: false },
      actioTaskIds: ["t-1", "t-9"],
      quotes: { ...raw().quotes, "acceptance.1": "Ex で反映を確認", "permissions.merge": "" },
    }));
    expect(result.extracted.acceptance).toEqual(["PR がマージされる"]);
    expect(result.extracted.permissions.merge).toBe(false);
    expect(result.extracted.actioTaskIds).toEqual(["t-1"]);
    expect(result.dropped).toEqual(["acceptance.1", "permissions.merge", "actio:t-9"]);
  });

  it("drops a goal or project without a grounded quote", () => {
    const result = guardExtraction(text, raw({ quotes: { "acceptance.0": "PR がマージされたら達成" } }));
    expect(result.extracted.project).toBeUndefined();
    expect(result.extracted.goalText).toBeUndefined();
    expect(result.dropped).toEqual(expect.arrayContaining(["project", "goalText"]));
  });

  it("normalizes width and whitespace before comparing", () => {
    expect(normalizeForQuote("ＰＲ  が\nマージ")).toBe("PR が マージ");
  });
});
