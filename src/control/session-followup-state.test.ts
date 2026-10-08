import { describe, expect, it } from "vitest";
import { renderSessionFollowup, selectSessionFollowupState, type SessionFollowupSnapshot } from "./session-followup-state.js";

const empty: SessionFollowupSnapshot = { workflow: "revisor", tasks: [], delegations: [], prs: [] };

describe("task-linked followup", () => {
  it("keeps a passing open PR in the loop until merge is recorded", () => {
    const snapshot = { ...empty, prs: [{ status: "open", checkStatus: "test_ok" }] };
    expect(selectSessionFollowupState(snapshot)).toBe("merge-confirmation");
    const guidance = renderSessionFollowup(snapshot);
    expect(guidance).toContain("既存の明示許可");
    expect(guidance).toContain("通常のマージ許可を再質問せず");
    expect(guidance).toContain("Test OKだけでは完了にしません");
    expect(selectSessionFollowupState({ ...snapshot, prs: [{ status: "open", checkStatus: "action_required" }] })).toBe("review-failed");
    expect(selectSessionFollowupState({ ...snapshot, prs: [{ status: "merged", checkStatus: "test_ok" }] })).toBe("reflection-needed");
  });
  it("uses linked Actio status independently of the legacy session phase", () => {
    expect(selectSessionFollowupState({ ...empty, tasks: [{ status: "open" }] })).toBe("task-active");
    expect(selectSessionFollowupState({ ...empty, tasks: [{ status: "in_progress" }] })).toBe("task-active");
    expect(selectSessionFollowupState({ ...empty, tasks: [{ status: "blocked" }] })).toBe("task-blocked");
    expect(selectSessionFollowupState({ ...empty, tasks: [{ status: "unknown" }] })).toBe("unknown");
  });

  it("does not restart work already owned by a child or under review", () => {
    expect(selectSessionFollowupState({ ...empty, delegations: [{ status: "running" }] })).toBe("delegation-wait");
    expect(selectSessionFollowupState({ ...empty, tasks: [{ status: "open" }], delegations: [{ status: "running" }] })).toBe("task-active");
    expect(selectSessionFollowupState({ ...empty, prs: [{ status: "open", checkStatus: "running" }] })).toBe("review-wait");
    expect(selectSessionFollowupState({ ...empty, prs: [{ status: "merged", checkStatus: "test_ok" }] })).toBe("reflection-needed");
    expect(selectSessionFollowupState({ ...empty, tasks: [{ status: "blocked" }], prs: [{ status: "merged", checkStatus: "test_ok" }] })).toBe("task-blocked");
    expect(renderSessionFollowup({ ...empty, prs: [{ status: "merged", checkStatus: "test_ok" }] })).toContain("merged だけでループを完了にしない");
  });

  it("reports external state as unknown without substituting a local phase", () => {
    const text = renderSessionFollowup();
    expect(text).toContain("state=unknown");
    expect(text).toContain("Actio・審査・委託状態は取得できていません");
    expect(text).toContain("人間の確認待ちは維持");
  });

  it("names only the sources that failed and the reasons tasks are unknown", () => {
    const text = renderSessionFollowup({ ...empty, unavailable: ["revisor-prs"],
      tasks: [{ status: "unknown", reason: "task_out_of_scope" }, { status: "unknown", reason: "task_out_of_scope" }] });
    expect(text).toContain("workflow=revisor");
    expect(text).toContain("取得できなかった状態: Revisor local PR");
    expect(text).not.toContain("Actio・審査・委託状態は取得できていません");
    expect(text).toContain("unknown の理由: task_out_of_scope");
    expect(renderSessionFollowup(empty)).not.toContain("取得できなかった状態");
  });
});
