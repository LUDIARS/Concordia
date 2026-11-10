import { describe, expect, it } from "vitest";
import {
  buildAlreadyAssignedText,
  buildAssignedNoticeText,
  buildAssignmentLine,
  buildBranchBriefRequestText,
  buildBriefRequestText,
  buildChildBriefText,
  buildChildEndedNoticeText,
  buildChildTitle,
  buildRejectedBriefText,
  extractPrNumbers,
  hasRepoBriefFence,
  parseRepoBriefs,
} from "./repo-brief.js";
import { resolveCheckout } from "./repo-agent-policy.js";

const REGISTERED = ["E:/Document/Ars/Concordia", "E:/Document/Ars/Memoria"];
const resolve = (path: string) => resolveCheckout(path, REGISTERED);

function block(body: string): string {
  return ["```repo-brief", body, "```"].join("\n");
}

describe("parseRepoBriefs (§3.3)", () => {
  it("複数ブロックを順に解析し checkout を登録 checkout へ解決する", () => {
    const text = [
      "前置き",
      block(JSON.stringify({ checkout: "E:\\Document\\Ars\\Concordia\\.wt-x", brief: "A を直す" })),
      "間の文",
      block(JSON.stringify({ checkout: "E:/Document/Ars/Memoria", brief: "B を足す" })),
    ].join("\n");
    expect(parseRepoBriefs(text, resolve)).toEqual({
      briefs: [
        { target: { checkout: "E:/Document/Ars/Concordia/.wt-x", repo: "E:/Document/Ars/Concordia" }, brief: "A を直す" },
        { target: { checkout: "E:/Document/Ars/Memoria", repo: "E:/Document/Ars/Memoria" }, brief: "B を足す" },
      ],
      rejected: [],
    });
  });

  it("不正 JSON・未登録 checkout・空 brief は理由付きで捨てる", () => {
    const text = [
      block("{not json"),
      block(JSON.stringify({ checkout: "E:/Document/Ars/Unknown", brief: "x" })),
      block(JSON.stringify({ checkout: "E:/Document/Ars/Memoria", brief: "  " })),
      block(JSON.stringify({ brief: "checkout 無し" })),
    ].join("\n");
    const parsed = parseRepoBriefs(text, resolve);
    expect(parsed.briefs).toEqual([]);
    expect(parsed.rejected).toEqual([
      { checkout: null, reason: "invalid_json" },
      { checkout: "E:/Document/Ars/Unknown", reason: "unregistered_checkout" },
      { checkout: "E:/Document/Ars/Memoria", reason: "empty_brief" },
      { checkout: null, reason: "unregistered_checkout" },
    ]);
    expect(buildRejectedBriefText(parsed.rejected)).toContain("JSON として読めません");
  });

  it("ブロックが無ければ何も返さない", () => {
    expect(hasRepoBriefFence("```ts\nconst a = 1;\n```")).toBe(false);
    expect(parseRepoBriefs("ただの文", resolve)).toEqual({ briefs: [], rejected: [] });
  });
});

describe("文面", () => {
  it("依頼文の書き方は checkout 入りの repo-brief 雛形を含み、 そのまま解析できる", () => {
    const text = buildBriefRequestText("E:/Document/Ars/Concordia/.wt-x");
    expect(text).toContain("起動 cwd と違うため");
    expect(parseRepoBriefs(text, resolve).briefs[0]?.target.checkout).toBe("E:/Document/Ars/Concordia/.wt-x");
  });

  it("副契機の案内は候補ごとに雛形を並べる", () => {
    const text = buildBranchBriefRequestText(["E:/Document/Ars/Memoria", "E:/Document/Ars/Concordia/.wt-b"]);
    expect(parseRepoBriefs(text, resolve).briefs.map((b) => b.target.checkout))
      .toEqual(["E:/Document/Ars/Memoria", "E:/Document/Ars/Concordia/.wt-b"]);
  });

  it("担当がいる checkout の案内は担当 id と追加依頼の送り方を示す (§3.5)", () => {
    const text = buildAlreadyAssignedText("E:/x", "child-1");
    expect(text).toContain("担当 child-1 がいます");
    expect(text).toContain("POST /v1/sessions/child-1/inject");
    expect(buildAlreadyAssignedText("E:/x", null)).toContain("準備中");
  });

  it("子への依頼文には担当であること・許可範囲・報告先を機械で付ける", () => {
    const text = buildChildBriefText({ parentSessionId: "p1", checkout: "E:/x", projectCode: "Cc", brief: "やること" });
    expect(text).toContain("親セッション p1 から [Cc] E:/x の実装を任された担当");
    expect(text).toContain("許可範囲");
    expect(text).toContain("親セッションへ報告");
    expect(text.endsWith("やること")).toBe(true);
  });

  it("子のタイトルは [code] + brief の 1 行目、 長ければ切る", () => {
    expect(buildChildTitle("Cc", "\n  目的: 自動引き継ぎ\n詳細")).toBe("[Cc] 目的: 自動引き継ぎ");
    expect(buildChildTitle(null, "あ".repeat(100)).length).toBe(60);
  });

  it("親への通知・1 行投稿・終了通知", () => {
    expect(buildAssignedNoticeText({ childSessionId: "c1", checkout: "E:/x", projectCode: "Cc", childThread: "<#9>" }))
      .toContain("スレッド: <#9>");
    expect(buildAssignmentLine({ projectCode: "Cc", checkout: "E:/Document/Ars/Concordia/.wt-x", childThread: "<#9>", childSessionId: "c1", ended: false }))
      .toBe("担当: [Cc] .wt-x → <#9>");
    const ended = buildChildEndedNoticeText({ childSessionId: "c1", checkout: "E:/x", lastMessage: "PR #812 を提出しました" });
    expect(ended).toContain("PR: #812");
    expect(ended).toContain("PR #812 を提出しました");
    expect(buildChildEndedNoticeText({ childSessionId: "c1", checkout: "E:/x", lastMessage: null })).toContain("取得できませんでした");
  });

  it("PR 番号を拾う", () => {
    expect(extractPrNumbers("PR#1 と https://github.com/o/r/pull/22 と pr 3")).toEqual([1, 22, 3]);
  });
});
