/** @implements spec/feature/autonomous-work-continuation.md §2 — 作業状態の指紋と変化なしの記録 */
import { describe, expect, it } from "vitest";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionFollowupSnapshot } from "./session-followup-state.js";
import {
  FOLLOWUP_PROGRESS_KEY,
  followupProgressFingerprint,
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

describe("followupProgressFingerprint", () => {
  it("並び順に依存せず、同じ作業状態なら同じ指紋になる", () => {
    const reordered = { ...base, tasks: [...base.tasks].reverse() };
    expect(followupProgressFingerprint("task-active", reordered)).toBe(followupProgressFingerprint("task-active", base));
  });

  it("state・PR の審査状態・委託・取得不能の取得元が変われば指紋も変わる", () => {
    const fp = followupProgressFingerprint("task-active", base);
    expect(followupProgressFingerprint("review-wait", base)).not.toBe(fp);
    expect(followupProgressFingerprint("task-active", { ...base, prs: [{ status: "open", checkStatus: "failed" }] })).not.toBe(fp);
    expect(followupProgressFingerprint("task-active", { ...base, delegations: [{ status: "completed" }] })).not.toBe(fp);
    expect(followupProgressFingerprint("task-active", { ...base, unavailable: ["actio"] })).not.toBe(fp);
    expect(followupProgressFingerprint("unknown", undefined)).toBe(followupProgressFingerprint("unknown", undefined));
  });
});

describe("recordFollowupProgress", () => {
  it("初回と変化した回は changed、同じ回は unchanged として数える", () => {
    const { repo, metadata } = fakeRepo();
    expect(recordFollowupProgress(repo, "s", "a", 1)).toEqual({ changed: true, unchangedCount: 0 });
    expect(recordFollowupProgress(repo, "s", "a", 2)).toEqual({ changed: false, unchangedCount: 1 });
    expect(recordFollowupProgress(repo, "s", "a", 3)).toEqual({ changed: false, unchangedCount: 2 });
    expect(metadata()[FOLLOWUP_PROGRESS_KEY]).toEqual({ fingerprint: "a", unchanged_count: 2, last_checked_at: 3, last_changed_at: 1 });
    expect(recordFollowupProgress(repo, "s", "b", 4)).toEqual({ changed: true, unchangedCount: 0 });
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
