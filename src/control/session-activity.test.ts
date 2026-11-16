/** @implements spec/feature/autonomous-work-continuation.md §2 — 自動確認と管制で共通の動きの判定 */
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_STALL_UNCHANGED_MIN,
  activityFingerprint,
  classifyActivity,
  conversationActivityMark,
  isActivityStalled,
} from "./session-activity.js";

const line = (o: unknown) => JSON.stringify(o);
const S = "[自動確認]";

describe("conversationActivityMark", () => {
  it("自動確認の後に返答と道具の結果しか無ければ quiet", () => {
    const tail = [
      line({ role: "user", content: `${S} 見直してください` }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
      line({ role: "assistant", content: "[変化なし]" }),
    ].join("\n");
    expect(conversationActivityMark(tail, 5, S)).toBe("quiet");
  });

  it("自動確認の後の人間の入力は内容で印を付け、最後の自動確認より前の入力は数えない", () => {
    const human = [line({ role: "user", content: `${S} a` }), line({ role: "user", content: "直して" })].join("\n");
    expect(conversationActivityMark(human, 5, S)).toMatch(/^human:/);
    const older = [line({ role: "user", content: "直して" }), line({ role: "user", content: `${S} b` })].join("\n");
    expect(conversationActivityMark(older, 5, S)).toBe("quiet");
  });

  it("自動確認が末尾に無ければ最終活動時刻、それも無ければ null", () => {
    expect(conversationActivityMark(line({ role: "assistant", content: "x" }), 7, S)).toBe("activity:7");
    expect(conversationActivityMark(null, null, S)).toBeNull();
  });
});

describe("activityFingerprint / classifyActivity / isActivityStalled", () => {
  const obs = { conversation: "quiet", head: "a", worktree: "", prs: ["open:running", "merged:test_ok"], delegations: [], sideReportedAt: 1 };

  it("並び順に依存しない", () => {
    expect(activityFingerprint({ ...obs, prs: [...obs.prs].reverse() })).toBe(activityFingerprint(obs));
  });

  it("全員無活動なら数え上げて止まっている扱い、動けば 0 に戻す", () => {
    const fp = activityFingerprint(obs);
    let record = classifyActivity(null, fp, 1);
    expect(record.unchanged_count).toBe(0);
    for (let i = 2; i <= 1 + ACTIVITY_STALL_UNCHANGED_MIN; i++) record = classifyActivity(record, fp, i);
    expect(record.unchanged_count).toBe(ACTIVITY_STALL_UNCHANGED_MIN);
    expect(isActivityStalled(record.unchanged_count)).toBe(true);
    record = classifyActivity(record, activityFingerprint({ ...obs, head: "b" }), 9);
    expect(record).toEqual({ fingerprint: expect.any(String), unchanged_count: 0, last_checked_at: 9, last_changed_at: 9 });
    expect(isActivityStalled(record.unchanged_count)).toBe(false);
  });
});
