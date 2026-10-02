import { describe, expect, it } from "vitest";
import {
  CONSULT_SESSION_MAX_MS,
  MAX_JUDGE_TRANSCRIPT_CHARS,
  SHARE_ANSWER_TIMEOUT_MS,
  countLeakedTerms,
  dailySweepDay,
  isConsultationOverdue,
  isShareAnswerOverdue,
  parseShareJudgement,
  renderConsultationTranscript,
} from "./closure-policy.js";

describe("isConsultationOverdue", () => {
  it("開いた相談は承認 (無ければ作成) から 24 時間で期限切れ", () => {
    const open = { status: "open" as const, approved_at: 1_000, created_at: 0 };
    expect(isConsultationOverdue(open, 1_000 + CONSULT_SESSION_MAX_MS - 1)).toBe(false);
    expect(isConsultationOverdue(open, 1_000 + CONSULT_SESSION_MAX_MS)).toBe(true);
    expect(isConsultationOverdue({ ...open, approved_at: null }, CONSULT_SESSION_MAX_MS)).toBe(true);
  });

  it("承認待ち・終了済みは対象外", () => {
    expect(isConsultationOverdue({ status: "pending_approval", approved_at: null, created_at: 0 }, CONSULT_SESSION_MAX_MS * 2)).toBe(false);
    expect(isConsultationOverdue({ status: "closed", approved_at: 0, created_at: 0 }, CONSULT_SESSION_MAX_MS * 2)).toBe(false);
  });
});

describe("isShareAnswerOverdue", () => {
  it("問いから 24 時間で反応なし扱い", () => {
    expect(isShareAnswerOverdue(5, 5 + SHARE_ANSWER_TIMEOUT_MS - 1)).toBe(false);
    expect(isShareAnswerOverdue(5, 5 + SHARE_ANSWER_TIMEOUT_MS)).toBe(true);
  });
});

describe("renderConsultationTranscript", () => {
  it("相談者と回答を順に並べ、 上限を超えたら新しい側を残す", () => {
    expect(renderConsultationTranscript([{ role: "user", text: "Q" }, { role: "assistant", text: "A" }, { role: "user", text: " " }]))
      .toBe("相談者: Q\n\n回答: A");
    const long = renderConsultationTranscript([{ role: "user", text: "x".repeat(MAX_JUDGE_TRANSCRIPT_CHARS) }, { role: "assistant", text: "END" }]);
    expect(long.length).toBe(MAX_JUDGE_TRANSCRIPT_CHARS);
    expect(long.endsWith("回答: END")).toBe(true);
  });
});

describe("parseShareJudgement", () => {
  it("publishable と題名・本文が揃えば共有候補", () => {
    expect(parseShareJudgement('判定: {"publishable": true, "title": "T", "summary": "S", "reason": "ok"}'))
      .toEqual({ publishable: true, title: "T", summary: "S" });
  });

  it("読めない・false・欠けは共有しない側へ倒す", () => {
    const no = { publishable: false, title: "", summary: "" };
    expect(parseShareJudgement("no json")).toEqual(no);
    expect(parseShareJudgement('{"publishable": false, "title": "T", "summary": "S"}')).toEqual(no);
    expect(parseShareJudgement('{"publishable": true, "title": "", "summary": "S"}')).toEqual(no);
    expect(parseShareJudgement("{broken")).toEqual(no);
  });
});

describe("dailySweepDay", () => {
  it("朝の指定時刻を過ぎてから、 その日 1 回だけ回す", () => {
    const at = (h: number, day = 15) => new Date(2026, 9, day, h).getTime();
    expect(dailySweepDay(at(8), 9, null)).toBeNull();
    expect(dailySweepDay(at(9), 9, null)).toBe("2026-10-15");
    expect(dailySweepDay(at(14), 9, "2026-10-15")).toBeNull();
    expect(dailySweepDay(at(9, 16), 9, "2026-10-15")).toBe("2026-10-16");
  });
});

describe("countLeakedTerms", () => {
  it("大小文字を区別せず、 3 文字以上の語の出現を数える", () => {
    expect(countLeakedTerms("Using FooProject with bar", ["fooproject", "Bar", "zz"])).toBe(2);
    expect(countLeakedTerms("一般的な説明", ["FooProject"])).toBe(0);
  });
});
