import { describe, expect, it } from "vitest";
import type { SessionEventRow } from "../shared/types.js";
import { attributeTotal, attributeUsage, instructionMarks, responsibleAt, sessionAttribution } from "./usage-attribution.js";

const LAUNCHER = "111111111";
const HELPER = "222222222";

function inject(ts: number, source: string): SessionEventRow {
  return { id: ts, session_id: "s1", ts, kind: "inject", payload: JSON.stringify({ text: "x", source }) };
}

describe("instructionMarks", () => {
  it("Discord の人の指示だけを時刻の昇順で取り出す (Cc の制御 inject は除く)", () => {
    const marks = instructionMarks([
      inject(20, `discord:${HELPER}:1:2`),
      inject(10, `discord:${LAUNCHER}:1:1`),
      inject(15, "initial-work"),
      { id: 1, session_id: "s1", ts: 12, kind: "prompt", payload: "{}" },
    ]);
    expect(marks).toEqual([{ atMs: 10_000, userId: LAUNCHER }, { atMs: 20_000, userId: HELPER }]);
  });
});

describe("attributeUsage", () => {
  const session = { team_id: null, metadata: JSON.stringify({ discord_requester_user_id: LAUNCHER }) };

  it("AI の応答ごとの区間で、 助けに入った人だけが指示した区間はその人のユーザー予算に付ける", () => {
    const attribution = sessionAttribution(session, [
      inject(10, `discord:${LAUNCHER}:1:1`),
      inject(20, `discord:${HELPER}:1:2`),
      inject(30, `discord:${LAUNCHER}:1:3`),
    ]);
    const charges = attributeUsage(attribution, [
      { atMs: 5_000, tokens: 1, turnEnd: true },
      { atMs: 12_000, tokens: 10, turnEnd: true },
      { atMs: 25_000, tokens: 100, turnEnd: true },
      { atMs: 35_000, tokens: 1_000, turnEnd: true },
    ]);
    expect(charges).toEqual(expect.arrayContaining([
      { subject: { scope: "user", targetId: LAUNCHER }, personUserId: LAUNCHER, tokens: 1_011 },
      { subject: { scope: "user", targetId: HELPER }, personUserId: HELPER, tokens: 100 },
    ]));
    expect(charges).toHaveLength(2);
  });

  it("同じ区間に複数の人が指示したら、 区間の消費を指示の回数で按分する (A 2 回・B 1 回 → 2/3 と 1/3)", () => {
    const attribution = sessionAttribution(session, [
      inject(10, `discord:${LAUNCHER}:1:1`),
      inject(20, `discord:${HELPER}:1:2`),
      inject(30, `discord:${LAUNCHER}:1:3`),
    ]);
    const charges = attributeUsage(attribution, [
      { atMs: 15_000, tokens: 300 },
      { atMs: 40_000, tokens: 600, turnEnd: true },
    ]);
    expect(charges).toEqual(expect.arrayContaining([
      { subject: { scope: "user", targetId: LAUNCHER }, personUserId: LAUNCHER, tokens: 600 },
      { subject: { scope: "user", targetId: HELPER }, personUserId: HELPER, tokens: 300 },
    ]));
    expect(charges).toHaveLength(2);
  });

  it("指示の無い区間は、 前の区間で助けに入った人ではなく起動時の帰属先に付ける", () => {
    const attribution = sessionAttribution(session, [inject(20, `discord:${HELPER}:1:2`)]);
    const charges = attributeUsage(attribution, [
      { atMs: 25_000, tokens: 100, turnEnd: true },
      { atMs: 40_000, tokens: 50, turnEnd: true },
    ]);
    expect(charges).toEqual(expect.arrayContaining([
      { subject: { scope: "user", targetId: HELPER }, personUserId: HELPER, tokens: 100 },
      { subject: { scope: "user", targetId: LAUNCHER }, personUserId: LAUNCHER, tokens: 50 },
    ]));
    expect(charges).toHaveLength(2);
  });

  it("起動者が分からないセッションは按分しても全額を起動時の帰属先へ付け、 倍率の人だけ分ける", () => {
    const attribution = sessionAttribution({ team_id: "team_a", metadata: null }, [
      inject(10, `discord:${LAUNCHER}:1:1`),
      inject(20, `discord:${HELPER}:1:2`),
    ]);
    const charges = attributeUsage(attribution, [{ atMs: 30_000, tokens: 200, turnEnd: true }]);
    expect(charges).toEqual(expect.arrayContaining([
      { subject: { scope: "team", targetId: "team_a" }, personUserId: LAUNCHER, tokens: 100 },
      { subject: { scope: "team", targetId: "team_a" }, personUserId: HELPER, tokens: 100 },
    ]));
    expect(charges).toHaveLength(2);
  });

  it("チームで起動したセッションは起動者の区間をチームに付け、 倍率は指示を出した人で掛ける", () => {
    const attribution = sessionAttribution(
      { team_id: "team_a", metadata: JSON.stringify({ discord_requester_user_id: LAUNCHER }) },
      [inject(20, `discord:${HELPER}:1:2`)],
    );
    expect(responsibleAt(attribution, 10_000)).toEqual({ subject: { scope: "team", targetId: "team_a" }, personUserId: LAUNCHER });
    expect(responsibleAt(attribution, 25_000)).toEqual({ subject: { scope: "user", targetId: HELPER }, personUserId: HELPER });
  });

  it("起動者が分からないセッションは助けを区別せず全区間を起動時の帰属先に付ける", () => {
    const attribution = sessionAttribution({ team_id: "team_a", metadata: null }, [inject(20, `discord:${HELPER}:1:2`)]);
    expect(responsibleAt(attribution, 25_000)).toEqual({ subject: { scope: "team", targetId: "team_a" }, personUserId: HELPER });
  });

  it("時刻の取れないセッションは合計を起動時の帰属先へまとめる", () => {
    const attribution = sessionAttribution(session, []);
    expect(attributeTotal(attribution, 500)).toEqual([{ subject: { scope: "user", targetId: LAUNCHER }, personUserId: LAUNCHER, tokens: 500 }]);
    expect(attributeTotal(sessionAttribution({ metadata: null }, []), 500)).toEqual([]);
  });
});
