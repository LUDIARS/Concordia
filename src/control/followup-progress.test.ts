/** @implements spec/feature/autonomous-work-continuation.md §2 — 観測された動きの指紋と変化なしの記録 */
import { describe, expect, it } from "vitest";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionFollowupSnapshot } from "./session-followup-state.js";
import {
  FOLLOWUP_PROGRESS_KEY,
  followupActivityFingerprint,
  type FollowupActivityInput,
  isFollowupNoChangeReply,
  nextFollowupProgress,
  readFollowupProgress,
  recordFollowupProgress,
  renderFollowupNoChangeNotice,
} from "./followup-progress.js";

const base: SessionFollowupSnapshot = {
  workflow: "revisor", tasks: [{ status: "in_progress" }, { status: "open" }], delegations: [{ status: "running" }],
  prs: [{ status: "open", checkStatus: "running" }], unavailable: [],
};

function fakeRepo(): { repo: Pick<SessionsRepo, "updateMetadata">; metadata: () => Record<string, unknown> } {
  let metadata: Record<string, unknown> = { keep: 1 };
  return {
    repo: { updateMetadata: (_id, fn) => { metadata = fn(metadata); } } as Pick<SessionsRepo, "updateMetadata">,
    metadata: () => metadata,
  };
}

const nudge = (text = "[自動確認] 状況を見直してください") => JSON.stringify({ role: "user", content: text });
const reply = JSON.stringify({ role: "assistant", content: "[変化なし]" });
const input = (over: Partial<FollowupActivityInput> = {}): FollowupActivityInput => ({
  tail: [nudge(), reply].join("\n"), lastActivityMs: 1_000, nudgeSentinel: "[自動確認]",
  git: { head: "aaa", worktree: "" }, snapshot: base, sideReportedAt: 10, ...over,
});

describe("followupActivityFingerprint", () => {
  it("追跡状態 (タスク・取得不能の取得元) が変わっても、観測された動きが同じなら同じ指紋になる", () => {
    const fp = followupActivityFingerprint(input());
    expect(followupActivityFingerprint(input({ snapshot: { ...base, tasks: [], unavailable: ["actio"] } }))).toBe(fp);
    // 自動確認に返答しただけなら最終活動時刻が進んでも変化なし。
    expect(followupActivityFingerprint(input({ lastActivityMs: 9_999 }))).toBe(fp);
  });

  it("コミット・作業ツリー・PR・委託・現況報告・人間の入力が動けば指紋も変わる", () => {
    const fp = followupActivityFingerprint(input());
    expect(followupActivityFingerprint(input({ git: { head: "bbb", worktree: "" } }))).not.toBe(fp);
    expect(followupActivityFingerprint(input({ git: { head: "aaa", worktree: " M src/a.ts" } }))).not.toBe(fp);
    expect(followupActivityFingerprint(input({ snapshot: { ...base, prs: [{ status: "open", checkStatus: "failed" }] } }))).not.toBe(fp);
    expect(followupActivityFingerprint(input({ snapshot: { ...base, delegations: [{ status: "completed" }] } }))).not.toBe(fp);
    expect(followupActivityFingerprint(input({ sideReportedAt: 11 }))).not.toBe(fp);
    expect(followupActivityFingerprint(input({ tail: [nudge(), reply, JSON.stringify({ role: "user", content: "続けて" })].join("\n") }))).not.toBe(fp);
  });

  it("末尾に自動確認が見えないほど会話が進んでいれば最終活動時刻で比べる", () => {
    const busy = (ms: number) => input({ tail: JSON.stringify({ role: "assistant", content: "実装中" }), lastActivityMs: ms });
    expect(followupActivityFingerprint(busy(1))).not.toBe(followupActivityFingerprint(busy(2)));
  });
});

describe("recordFollowupProgress", () => {
  it("初回と変化した回は changed、同じ回は unchanged として数える", () => {
    const { repo, metadata } = fakeRepo();
    expect(recordFollowupProgress(repo, "s", "a", 1)).toEqual({ changed: true, unchangedCount: 0 });
    expect(recordFollowupProgress(repo, "s", "a", 2)).toEqual({ changed: false, unchangedCount: 1 });
    expect(recordFollowupProgress(repo, "s", "a", 3)).toEqual({ changed: false, unchangedCount: 2 });
    expect(metadata()[FOLLOWUP_PROGRESS_KEY]).toEqual({ fingerprint: "a", unchanged_count: 2, last_checked_at: 3, last_changed_at: 1 });
    expect(recordFollowupProgress(repo, "s", "b", 4, "unknown")).toEqual({ changed: true, unchangedCount: 0 });
    expect(readFollowupProgress(JSON.stringify(metadata()))?.state).toBe("unknown");
    expect(metadata().keep).toBe(1);
  });

  it("壊れた記録は初回扱いにする", () => {
    expect(readFollowupProgress("broken")).toBeNull();
    expect(readFollowupProgress(JSON.stringify({ [FOLLOWUP_PROGRESS_KEY]: { fingerprint: 1 } }))).toBeNull();
    expect(nextFollowupProgress(null, "x", 5)).toEqual({ fingerprint: "x", unchanged_count: 0, last_checked_at: 5, last_changed_at: 5 });
  });
});

describe("変化なしの返信", () => {
  it("案内に返信用の一行を示し、その一行だけを変化なしと判定する", () => {
    expect(renderFollowupNoChangeNotice().join("\n")).toContain("`[変化なし]`");
    expect(isFollowupNoChangeReply("[変化なし]")).toBe(true);
    expect(isFollowupNoChangeReply("  [変化なし]\n")).toBe(true);
    expect(isFollowupNoChangeReply("[変化なし] ただし PR を再提出しました")).toBe(false);
    expect(isFollowupNoChangeReply("")).toBe(false);
    expect(isFollowupNoChangeReply(null)).toBe(false);
  });
});
