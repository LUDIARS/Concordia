import { describe, expect, it, vi } from "vitest";
import type { LearningRunRow, LearningSourceRow } from "../db/patrol-learning-repo.js";
import { createLearningJournalSync, renderLearningJournal } from "./patrol-learning-journal.js";

const run = (over: Partial<LearningRunRow>): LearningRunRow => ({
  run_id: "r1", rule_id: "glab-trend-patrol", day: "2026-10-17", status: "applied", fragment_count: 4,
  proposal: null, applied: null, reason: null, revision: null, created_at: 0, ...over,
});

function fakeRepo(byDay: Record<string, LearningRunRow[]>, sources: Record<string, LearningSourceRow[]> = {}) {
  return {
    recentLearningDays: (limit: number) => Object.keys(byDay).sort().reverse().slice(0, limit),
    listRunsByDay: (day: string) => byDay[day] ?? [],
    sourcesForRun: (runId: string) => sources[runId] ?? [],
  };
}

describe("patrol learning journal", () => {
  it("writes each rule's result, summary, the settings it changed and the talk it learned from", () => {
    const sources: LearningSourceRow[] = [
      { kind: "message", signal: null, created_at: 1, text: "もっと\nゲームの話がいい", reply_to_text: "新作の話題", replies: [] },
      { kind: "conversation", signal: JSON.stringify({ replies: 1, reactors: 2, fine: 2, bad: 0 }), created_at: 2, text: "UNIX 哲学の話", reply_to_text: null, replies: ["いいね"] },
      { kind: "message", signal: null, created_at: 3, text: null, reply_to_text: null, replies: [] },
    ];
    const body = renderLearningJournal("2026-10-17", [
      run({
        proposal: JSON.stringify({ summary: "アニメ寄りに" }),
        applied: JSON.stringify({ prefer_genres: ["anime", "game"], prefer_ratio: 0.75, learned_keywords: ["AI"] }),
        reason: "アニメ寄りに", revision: 6,
      }),
      run({ run_id: "r2", rule_id: "tendentia-trend-trial", status: "skipped", fragment_count: 2, reason: "not enough fragments (2/3)" }),
    ], (id) => (id === "r1" ? sources : []));
    expect(body.title).toBe("巡回チャットの学習 (2026-10-17)");
    expect(body.markdown).toContain("### glab-trend-patrol — 反映した");
    expect(body.markdown).toContain("- 要約: アニメ寄りに");
    expect(body.markdown).not.toContain("- 理由: アニメ寄りに");
    expect(body.markdown).toContain("  - 優先するジャンル: anime、game");
    expect(body.markdown).toContain("  - 関心のある言葉: AI");
    expect(body.markdown).toContain("- 反映後の版: rev 6");
    expect(body.markdown).toContain("  - 発言 「もっと ゲームの話がいい」 ← 返信先 「新作の話題」");
    expect(body.markdown).toContain("  - 投稿 「UNIX 哲学の話」 (返信 1 件・反応 2 人、 良い 2 / 悪い 0)");
    expect(body.markdown).toContain("    - 返信 「いいね」");
    expect(body.markdown).toContain("  - 発言 (発言は残っていません)");
    expect(body.markdown).toContain("### tendentia-trend-trial — 見送り");
    expect(body.markdown).toContain("- 理由: not enough fragments (2/3)");
  });

  it("puts the days that already exist, then only the days whose runs change", async () => {
    const byDay: Record<string, LearningRunRow[]> = {
      "2026-10-16": [run({ run_id: "a", day: "2026-10-16", status: "skipped" })],
      "2026-10-17": [run({ run_id: "b" })],
    };
    const put = vi.fn(async (_day: string, _source: string, _body: { title: string; markdown: string }) => ({ ok: true as const, value: {} }));
    const sync = createLearningJournalSync({ repo: fakeRepo(byDay), journal: { putDiarySection: put } });
    await sync.sync();
    expect(put.mock.calls.map((c) => c[0])).toEqual(["2026-10-17", "2026-10-16"]);
    await sync.sync();
    expect(put).toHaveBeenCalledTimes(2);
    byDay["2026-10-17"].push(run({ run_id: "c", rule_id: "vob-trend-patrol" }));
    await sync.sync();
    expect(put).toHaveBeenCalledTimes(3);
    expect(put.mock.calls[2][0]).toBe("2026-10-17");
  });

  it("stops at the first refusal and resends on the next pass", async () => {
    const warn = vi.fn();
    const put = vi.fn(async () => ({ ok: false as const, kind: "rejected" as const, error: "memoria responded 400" }));
    const sync = createLearningJournalSync({
      repo: fakeRepo({ "2026-10-16": [run({ run_id: "a" })], "2026-10-17": [run({ run_id: "b" })] }),
      journal: { putDiarySection: put },
      log: { warn },
    });
    await sync.sync();
    expect(put).toHaveBeenCalledTimes(1);
    await sync.sync();
    expect(put).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("memoria rejected"));
  });
});
