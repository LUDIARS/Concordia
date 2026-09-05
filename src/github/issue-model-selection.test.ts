import { describe, expect, it } from "vitest";
import type { ForumModelChoice } from "../delegation/forum-model-selection.js";
import { matchIssueModelDirective, selectIssueFixModel } from "./issue-model-selection.js";

const NOW_SEC = 1_788_600_000;

const CHOICES: ForumModelChoice[] = [
  { nick: "opus", label: "Opus (claude-opus-5)", provider: "claude", model: "claude-opus-5", emoji: null, defaultEffort: "high" },
  { nick: "sol", label: "Sol (gpt-5.6-sol)", provider: "codex", model: "gpt-5.6-sol", emoji: null, defaultEffort: "xhigh" },
  { nick: "sonnet", label: "Sonnet (claude-sonnet-5)", provider: "claude", model: "claude-sonnet-5", emoji: null, defaultEffort: "high" },
];

/** 残量が半々。 これを基準に片方だけ動かして選択の向きを見る。 */
function base(overrides: Partial<Parameters<typeof selectIssueFixModel>[0]> = {}) {
  return {
    issueBody: "再現手順だけ書いてある本文",
    choices: CHOICES,
    claudeWeekly: { usedPct: 50, resetAtSec: NOW_SEC + 7 * 86_400 },
    codexWeekly: { usedPct: 50, resetAtSec: NOW_SEC + 7 * 86_400 },
    nowSec: NOW_SEC,
    ...overrides,
  };
}

describe("matchIssueModelDirective", () => {
  it("reads a model line by nickname and by model id", () => {
    expect(matchIssueModelDirective("model: sol\n本文", CHOICES)?.nick).toBe("sol");
    expect(matchIssueModelDirective("モデル: claude-sonnet-5", CHOICES)?.nick).toBe("sonnet");
    expect(matchIssueModelDirective("- Model = opus", CHOICES)?.nick).toBe("opus");
  });

  it("ignores an unknown model so the catalog stays the only source of ids", () => {
    expect(matchIssueModelDirective("model: gpt-9-imaginary", CHOICES)).toBeNull();
    expect(matchIssueModelDirective("モデルの選定は任せます", CHOICES)).toBeNull();
  });
});

describe("selectIssueFixModel", () => {
  it("follows an explicit model line in the issue body", () => {
    const picked = selectIssueFixModel(base({ issueBody: "model: sonnet\n\n直してください" }));
    expect(picked).toMatchObject({ nick: "sonnet", provider: "claude", model: "claude-sonnet-5", source: "issue_body" });
  });

  it("follows a single unambiguous mention when there is no model line", () => {
    const picked = selectIssueFixModel(base({ issueBody: "sol で直してほしい" }));
    expect(picked).toMatchObject({ nick: "sol", source: "issue_body" });
  });

  it("does not treat forum effort words in the issue as an effort override", () => {
    const picked = selectIssueFixModel(base({ issueBody: "sol で low priority の不具合を直してほしい" }));
    expect(picked).toMatchObject({ nick: "sol", effort: "xhigh", source: "issue_body" });
  });

  // 指定なしの既定は Opus / Sol の 2 択で、 週間枠の残り (1 日あたりに使える量) が多い方。
  it("falls back to whichever of opus and sol has more weekly headroom", () => {
    const codexRich = selectIssueFixModel(base({ claudeWeekly: { usedPct: 90, resetAtSec: NOW_SEC + 7 * 86_400 } }));
    expect(codexRich).toMatchObject({ nick: "sol", provider: "codex", source: "usage_balance" });

    const claudeRich = selectIssueFixModel(base({ codexWeekly: { usedPct: 95, resetAtSec: NOW_SEC + 7 * 86_400 } }));
    expect(claudeRich).toMatchObject({ nick: "opus", provider: "claude", source: "usage_balance" });
  });

  it("never falls back to a model outside opus and sol", () => {
    const picked = selectIssueFixModel(base({ claudeWeekly: null, codexWeekly: null }));
    expect(["opus", "sol"]).toContain(picked?.nick);
    expect(picked?.source).toBe("usage_balance");
  });

  it("uses the remaining candidate when only one of the two is in the catalog", () => {
    const onlySol = CHOICES.filter((choice) => choice.nick !== "opus");
    const picked = selectIssueFixModel(base({
      choices: onlySol,
      codexWeekly: { usedPct: 99, resetAtSec: NOW_SEC + 7 * 86_400 },
    }));
    expect(picked?.nick).toBe("sol");
  });

  // モデルを決められないことは Issue の修正を止める理由にならない (テンプレ既定で起動する)。
  it("returns null when neither candidate is available", () => {
    const noCandidates = CHOICES.filter((choice) => choice.nick === "sonnet");
    expect(selectIssueFixModel(base({ choices: noCandidates }))).toBeNull();
  });
});
