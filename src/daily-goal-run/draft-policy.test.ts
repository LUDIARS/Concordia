import { describe, expect, it } from "vitest";
import { evaluateDraft } from "./draft-policy.js";
import type { ExtractedGoal } from "./domain.js";

const none = { merge: false, test: false, service: false, deploy: false };
const extracted = (patch: Partial<ExtractedGoal> = {}): ExtractedGoal => ({
  project: "Cc", goalText: "出荷する", acceptance: ["PR がマージされる"], permissions: none, actioTaskIds: [], quotes: {}, ...patch,
});
const resolved = { project: "Concordia", repoPath: "E:/repo" };

describe("evaluateDraft (受け入れ基準: 3 項目がそろえば登録、欠ければ足りない項目を返す)", () => {
  it("completes with project, goal and acceptance; Actio tasks and permissions are optional", () => {
    expect(evaluateDraft(extracted(), resolved)).toEqual({ status: "complete", goal: {
      project: "Concordia", repoPath: "E:/repo", goalText: "出荷する", acceptance: ["PR がマージされる"], actioTaskIds: [], permissions: none,
    } });
  });

  it("names every missing field", () => {
    expect(evaluateDraft(extracted({ goalText: " ", acceptance: [] }), resolved)).toEqual({ status: "missing", missing: ["goal", "acceptance"], projectUnresolved: false });
    expect(evaluateDraft(null, null)).toEqual({ status: "missing", missing: ["project", "goal", "acceptance"], projectUnresolved: false });
  });

  it("treats a project that the registry cannot resolve uniquely as missing", () => {
    expect(evaluateDraft(extracted({ project: "謎" }), null)).toEqual({ status: "missing", missing: ["project"], projectUnresolved: true });
  });
});
