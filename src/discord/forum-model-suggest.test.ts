import { describe, expect, it } from "vitest";
import {
  classifyForumTaskKind,
  effortForTaskKind,
  isFablePreferred,
  pickProviderFamilyByCostRatio,
  remainingQuotaRatio,
  suggestForumModel,
} from "./forum-model-suggest.js";
import type { ForumModelChoice } from "./forum-spawn.js";

// 2026-09-03 neco 指示: モデル/Effort は機械的にサジェストする。
//  実装・修正 → Opus / Sol mid、 設計・レビュー → Fable / Opus、 雑用 → Sonnet / Terra。
//  Claude 系 / Codex 系は残りコスト比 (週間残量 ÷ 残り日数)、 Fable は使用量ゲート。

const NOW = 1_700_000_000;
const DAY = 86_400;

function choice(nick: ForumModelChoice["nick"], provider: string): ForumModelChoice {
  return { nick, label: nick, provider, model: `${nick}-model`, emoji: null, defaultEffort: provider === "claude" ? "high" : "xhigh" };
}
const ALL_CHOICES: ForumModelChoice[] = [
  choice("fable", "claude"),
  choice("opus", "claude"),
  choice("sonnet", "claude"),
  choice("sol", "codex"),
  choice("terra", "codex"),
];

describe("classifyForumTaskKind", () => {
  it("設計・レビュー > 雑用 > 実装・修正 の順で語彙照合し、無印は実装扱い", () => {
    expect(classifyForumTaskKind("レビュー", "PR を見て")).toBe("design_review");
    expect(classifyForumTaskKind("t", "認証周りの設計を検討して")).toBe("design_review");
    expect(classifyForumTaskKind("t", "typo を修正して")).toBe("chore");
    expect(classifyForumTaskKind("t", "依存更新の PR を出して")).toBe("chore");
    expect(classifyForumTaskKind("t", "ログイン画面の不具合を直して")).toBe("implementation");
    expect(classifyForumTaskKind("t", "なんとかして")).toBe("implementation");
  });
});

describe("remainingQuotaRatio / pickProviderFamilyByCostRatio", () => {
  it("残量% ÷ 残り日数 を比にする (リセット不明は 7 日で割る)", () => {
    expect(remainingQuotaRatio({ usedPct: 40, resetAtSec: NOW + 3 * DAY }, NOW)).toBeCloseTo(20);
    expect(remainingQuotaRatio({ usedPct: 30, resetAtSec: null }, NOW)).toBeCloseTo(10);
    expect(remainingQuotaRatio({ usedPct: null, resetAtSec: NOW + DAY }, NOW)).toBeNull();
    expect(remainingQuotaRatio(null, NOW)).toBeNull();
  });

  it("リセット間際の極端な比は下限日数で抑える", () => {
    expect(remainingQuotaRatio({ usedPct: 0, resetAtSec: NOW + 60 }, NOW)).toBeCloseTo(400);
  });

  it("比が大きい方を採り、片方しか取れなければ取れた方、両方無ければ claude", () => {
    // codex: 残 80% / 4 日 = 20、 claude: 残 60% / 2 日 = 30 → claude
    expect(pickProviderFamilyByCostRatio({
      codexWeekly: { usedPct: 20, resetAtSec: NOW + 4 * DAY },
      claudeWeekly: { usedPct: 40, resetAtSec: NOW + 2 * DAY },
      nowSec: NOW,
    }).family).toBe("claude");
    // codex: 残 90% / 1 日 = 90、 claude: 残 60% / 2 日 = 30 → codex
    expect(pickProviderFamilyByCostRatio({
      codexWeekly: { usedPct: 10, resetAtSec: NOW + DAY },
      claudeWeekly: { usedPct: 40, resetAtSec: NOW + 2 * DAY },
      nowSec: NOW,
    }).family).toBe("codex");
    expect(pickProviderFamilyByCostRatio({
      codexWeekly: null,
      claudeWeekly: { usedPct: 95, resetAtSec: NOW + DAY },
      nowSec: NOW,
    }).family).toBe("claude");
    expect(pickProviderFamilyByCostRatio({
      codexWeekly: { usedPct: 95, resetAtSec: NOW + DAY },
      claudeWeekly: null,
      nowSec: NOW,
    }).family).toBe("codex");
    expect(pickProviderFamilyByCostRatio({ codexWeekly: null, claudeWeekly: null, nowSec: NOW }).family).toBe("claude");
  });
});

describe("isFablePreferred", () => {
  it("Fable 使用量 < 70% かつ 週間使用量 > Fable 使用量 のときだけ", () => {
    expect(isFablePreferred(30, 50)).toBe(true);
    expect(isFablePreferred(70, 90)).toBe(false);
    expect(isFablePreferred(30, 30)).toBe(false);
    expect(isFablePreferred(30, 20)).toBe(false);
    expect(isFablePreferred(null, 50)).toBe(false);
    expect(isFablePreferred(30, null)).toBe(false);
  });
});

describe("suggestForumModel", () => {
  const codexRich = { usedPct: 10, resetAtSec: NOW + DAY };
  const claudeRich = { usedPct: 10, resetAtSec: NOW + DAY };
  const claudePoor = { usedPct: 80, resetAtSec: NOW + 6 * DAY };

  it("実装・修正: Claude 系なら Opus、 Codex 系なら Sol、 effort は medium", () => {
    expect(suggestForumModel({
      title: "t", body: "不具合を修正して", choices: ALL_CHOICES,
      codexWeekly: codexRich, claudeWeekly: claudePoor, fableUsedPct: null, nowSec: NOW,
    })).toMatchObject({ nick: "sol", effort: "medium", kind: "implementation", family: "codex" });
    expect(suggestForumModel({
      title: "t", body: "不具合を修正して", choices: ALL_CHOICES,
      codexWeekly: null, claudeWeekly: claudeRich, fableUsedPct: null, nowSec: NOW,
    })).toMatchObject({ nick: "opus", effort: "medium", family: "claude" });
  });

  it("設計・レビュー: 常に Claude 系。 Fable ゲートを通れば Fable、 通らなければ Opus", () => {
    const base = { title: "レビュー", body: "設計を見て", choices: ALL_CHOICES, nowSec: NOW };
    expect(suggestForumModel({ ...base, codexWeekly: codexRich, claudeWeekly: claudePoor, fableUsedPct: null }))
      .toMatchObject({ nick: "opus", effort: "high", family: "claude" });
    expect(suggestForumModel({ ...base, codexWeekly: codexRich, claudeWeekly: claudePoor, fableUsedPct: 40 }))
      .toMatchObject({ nick: "fable", effort: "high", reason: expect.stringContaining("Fable 枠あり") });
    expect(suggestForumModel({ ...base, codexWeekly: codexRich, claudeWeekly: claudePoor, fableUsedPct: 85 }))
      .toMatchObject({ nick: "opus", reason: expect.stringContaining("Fable 枠なし") });
  });

  it("雑用: Claude 系なら Sonnet、 Codex 系なら Terra、 effort は low", () => {
    expect(suggestForumModel({
      title: "t", body: "typo を直して", choices: ALL_CHOICES,
      codexWeekly: codexRich, claudeWeekly: claudePoor, fableUsedPct: null, nowSec: NOW,
    })).toMatchObject({ nick: "terra", effort: "low", kind: "chore" });
    expect(suggestForumModel({
      title: "t", body: "README を整理して", choices: ALL_CHOICES,
      codexWeekly: null, claudeWeekly: null, fableUsedPct: null, nowSec: NOW,
    })).toMatchObject({ nick: "sonnet", effort: "low", reason: expect.stringContaining("残枠 不明") });
  });

  it("候補に無いモデルは次点へ倒し、どれも無ければ null", () => {
    const claudeOnly = ALL_CHOICES.filter((c) => c.provider === "claude");
    expect(suggestForumModel({
      title: "t", body: "修正", choices: claudeOnly,
      codexWeekly: codexRich, claudeWeekly: claudePoor, fableUsedPct: null, nowSec: NOW,
    })).toMatchObject({ nick: "opus", family: "claude" });
    expect(suggestForumModel({
      title: "レビュー", body: "設計を見て", choices: [choice("fable", "claude")],
      codexWeekly: codexRich, claudeWeekly: claudePoor, fableUsedPct: null, nowSec: NOW,
    })).toBeNull();
    expect(suggestForumModel({
      title: "t", body: "修正", choices: [],
      codexWeekly: null, claudeWeekly: null, fableUsedPct: null, nowSec: NOW,
    })).toBeNull();
  });

  it("effortForTaskKind は種別ごとに固定", () => {
    expect(effortForTaskKind("implementation")).toBe("medium");
    expect(effortForTaskKind("design_review")).toBe("high");
    expect(effortForTaskKind("chore")).toBe("low");
  });
});
