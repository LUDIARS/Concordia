import { describe, expect, it } from "vitest";
import { selectInternalAgent } from "./internal-agent-policy.js";
import { suggestForumModel } from "../discord/forum-model-suggest.js";
import { forumModelChoices } from "./forum-model-selection.js";
const templates = [
  { call_name: "opus", is_active: true, target_provider: "claude", model: "claude-opus-5" },
  { call_name: "sonnet", is_active: true, target_provider: "claude", model: "claude-sonnet-5" },
  { call_name: "sol-mid", is_active: true, target_provider: "codex", model: "gpt-6-sol" },
  { call_name: "terra", is_active: true, target_provider: "codex", model: "gpt-5.6-terra" },
];
describe("internal child-task selection", () => {
  it.each(["README typo", "API実装", "設計レビュー"])("inherits the existing policy for %s", (body) => {
    for (const codexUsed of [5, 95]) {
      const input = { title: "", body, templates, codexWeekly: { usedPct: codexUsed, resetAtSec: null },
        claudeWeekly: { usedPct: 50, resetAtSec: null }, fableUsedPct: null, nowSec: 100 };
      const choices = forumModelChoices(templates);
      const expected = suggestForumModel({ ...input, choices })!;
      const actual = selectInternalAgent(input)!;
      expect(actual.model).toBe(choices.find(c => c.nick === expected.nick)!.model);
      expect(actual.reasoning_effort).toBe(expected.effort);
      expect(templates.some(t => t.call_name === actual.call_name)).toBe(true);
    }
  });
  it("does not fall back to an inherited model when no active candidate exists", () => {
    expect(selectInternalAgent({ title: "", body: "fix", templates: [], codexWeekly: null,
      claudeWeekly: null, fableUsedPct: null, nowSec: 1 })).toBeNull();
  });
});
