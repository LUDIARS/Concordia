import { describe, expect, it } from "vitest";
import { answerLink, elapsedLabel, elapsedStyle, visibleItems } from "./view-model.js";
import type { InboxItem } from "../../api.js";

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    key: "ask-card:1",
    kind: "ask-card",
    summary: "答えて",
    raised_at: 0,
    elapsed_ms: 0,
    session_id: null,
    case_id: null,
    repo_origin: null,
    pr_number: null,
    read_at: null,
    snoozed_until: null,
    snoozed: false,
    ...over,
  };
}

const HOUR = 3_600_000;

describe("経過時間", () => {
  it("分・時間・日で丸める", () => {
    expect(elapsedLabel(90_000)).toBe("1分");
    expect(elapsedLabel(5 * HOUR)).toBe("5時間");
    expect(elapsedLabel(50 * HOUR)).toBe("2日");
  });

  it("負の値でも壊れない (時計のずれ)", () => {
    expect(elapsedLabel(-1000)).toBe("0分");
  });

  it("24h を超えると強調する (催促の閾値と同じ)", () => {
    expect(elapsedStyle(HOUR)).not.toContain("warn");
    expect(elapsedStyle(25 * HOUR)).toContain("warn");
  });
});

describe("回答経路", () => {
  it("セッション由来はセッションへ送る", () => {
    expect(answerLink(item({ session_id: "s1" }))?.to).toBe("/sessions/s1");
  });

  it("セッション ID を path segment としてエンコードする", () => {
    expect(answerLink(item({ session_id: "../../settings?tab=details" }))?.to)
      .toBe("/sessions/..%2F..%2Fsettings%3Ftab%3Ddetails");
  });

  it("case 専用 route がない間は無関係な画面へ誘導しない", () => {
    expect(answerLink(item({ case_id: "case-1" }))).toBeNull();
  });

  it("PR 由来は PR キューへ送る", () => {
    expect(answerLink(item({ pr_number: 1364 }))?.to).toBe("/prs");
  });

  it("session が優先される (両方ある confirm 待ちなど)", () => {
    expect(answerLink(item({ session_id: "s1", pr_number: 1 }))?.to).toBe("/sessions/s1");
  });

  it("どこへも送れなければ null (嘘のリンクを出さない)", () => {
    expect(answerLink(item())).toBeNull();
  });

  it("pr_number が 0 でもリンクする (0 番は falsy だが有効な値ではない — null 判定で見る)", () => {
    expect(answerLink(item({ pr_number: 0 }))?.to).toBe("/prs");
  });
});

describe("スヌーズの表示", () => {
  it("既定ではスヌーズ中を隠す", () => {
    const items = [item({ key: "a" }), item({ key: "b", snoozed: true })];
    expect(visibleItems(items, false).map((row) => row.key)).toEqual(["a"]);
  });

  it("表示を選べば出す", () => {
    const items = [item({ key: "a" }), item({ key: "b", snoozed: true })];
    expect(visibleItems(items, true)).toHaveLength(2);
  });
});
