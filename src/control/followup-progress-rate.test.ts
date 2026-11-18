import { describe, expect, it } from "vitest";
import { computeFollowupProgressRate, renderProgressRate } from "./followup-progress-rate.js";
import { renderFollowupInvestigation } from "./followup-investigation.js";
import { selectSessionFollowupState, renderSessionFollowup, type SessionFollowupSnapshot } from "./session-followup-state.js";

const snap = (over: Partial<SessionFollowupSnapshot> = {}): SessionFollowupSnapshot => ({
  workflow: "revisor", tasks: [], delegations: [], prs: [], unavailable: [], ...over,
});

describe("FU-RATE computeFollowupProgressRate", () => {
  it("項目が無ければ null (未計測)", () => {
    expect(computeFollowupProgressRate(undefined)).toBeNull();
    expect(computeFollowupProgressRate(snap())).toBeNull();
    expect(renderProgressRate(null)).toContain("未計測");
  });

  it("タスクと PR の段階を平均する", () => {
    expect(computeFollowupProgressRate(snap({ tasks: [{ status: "done" }, { status: "open" }] }))).toBe(50);
    expect(computeFollowupProgressRate(snap({ prs: [{ status: "open", checkStatus: "running" }] }))).toBe(60);
    expect(computeFollowupProgressRate(snap({ prs: [{ status: "open", checkStatus: "test_ok" }] }))).toBe(80);
    expect(computeFollowupProgressRate(snap({ prs: [{ status: "open", checkStatus: "failed" }] }))).toBe(50);
    expect(computeFollowupProgressRate(snap({ tasks: [{ status: "in_progress" }], prs: [{ status: "merged", checkStatus: "test_ok" }] }))).toBe(60);
  });

  it("merged は反映を観測できないので 100 にしない。unknown タスクと closed PR は数えない", () => {
    expect(computeFollowupProgressRate(snap({ prs: [{ status: "merged", checkStatus: "test_ok" }] }))).toBe(90);
    expect(computeFollowupProgressRate(snap({ tasks: [{ status: "unknown" }], prs: [{ status: "closed", checkStatus: "failed" }] }))).toBeNull();
  });
});

describe("FU-UNTRACKED", () => {
  it("タスク・PR・委託が無く取得失敗も無ければ untracked、取得失敗があれば unknown のまま", () => {
    expect(selectSessionFollowupState(snap())).toBe("untracked");
    expect(selectSessionFollowupState(snap({ unavailable: ["revisor-prs"] }))).toBe("unknown");
    expect(selectSessionFollowupState(snap({ tasks: [{ status: "unknown" }] }))).toBe("unknown");
  });

  it("本文に進捗率と紐付けの案内を出す", () => {
    const text = renderSessionFollowup(snap());
    expect(text).toContain("state=untracked");
    expect(text).toContain("進捗率: 未計測");
    expect(renderSessionFollowup(snap({ prs: [{ status: "open", checkStatus: "test_ok" }] }))).toContain("進捗率: 80%");
  });

  it("マージ済み PR だけのセッションは reflection-needed (untracked にしない)", () => {
    expect(selectSessionFollowupState(snap({ prs: [{ status: "merged", checkStatus: "test_ok" }] }))).toBe("reflection-needed");
  });
});

describe("FU-INVESTIGATE renderFollowupInvestigation", () => {
  it("人間の指示待ち・作業完了 (終了提案)・作業継続の 3 択を示し、[変化なし] だけの返信を求めない", () => {
    const text = renderFollowupInvestigation(90, 3).join("\n");
    expect(text).toContain("[原因調査モード] 進捗率: 90%");
    expect(text).toContain("連続 3 回");
    expect(text).toContain("人間の指示待ち");
    expect(text).toContain("ask マーカーで人間にセッション終了を提案");
    expect(text).toContain("回答が来るまで session-end しない");
    expect(text).toContain("`[変化なし]` だけで返さないでください");
  });
});
