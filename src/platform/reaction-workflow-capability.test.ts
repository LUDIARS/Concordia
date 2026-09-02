import { describe, expect, it } from "vitest";

import { WORKFLOW_ACTIONS } from "./reaction-workflow.js";
import {
  workflowActionCapability,
  workflowActionDefaults,
  workflowActionSubsidiaryAllowed,
  workflowDenialMessage,
} from "./reaction-workflow-capability.js";
import {
  CAPABILITY_MIN_ROLE,
  STAFF_CAPABILITIES,
  STAFF_ROLE_LABEL,
  capabilityAllowed,
} from "../staff/roles.js";

describe("reaction workflow capabilities", () => {
  // リアクション自体は誰でも押せる = 発火の可否では権限を問わない。
  it("lets anyone fire a workflow", () => {
    expect(capabilityAllowed(null, "reaction_workflow")).toBe(true);
    expect(CAPABILITY_MIN_ROLE.reaction_workflow).toBe("staff");
  });

  it("requires a capability only for the actions that actually change something", () => {
    expect(workflowActionCapability("delegate-task")).toBe("session_spawn");
    expect(workflowActionCapability("merge-pr")).toBe("merge_pr");
    expect(workflowActionCapability("sync-project-main-after-merge")).toBe("merge_pr");
  });

  // カスタムワークフローは対応表を通らずに走るので、 登録を開けると任意プロンプトを
  // 絵文字に束ねて権限判定を迂回できてしまう。 登録側で閉じる。
  it("closes the custom-workflow escape hatch by gating registration", () => {
    expect(workflowActionCapability("add-as-workflow")).toBe("session_spawn");
    expect(capabilityAllowed("staff", "session_spawn")).toBe(false);
  });

  // AI への作業指示は追加権限を要らない (それが「指示の簡略化」の意味)。
  it("asks for nothing extra on instruction-shaped actions", () => {
    for (const action of ["enumerate-remaining", "memoria-task", "status-check", "start-impl"] as const) {
      expect(workflowActionCapability(action)).toBeNull();
    }
  });

  it("covers every action so a new one is a deliberate decision", () => {
    for (const action of WORKFLOW_ACTIONS) {
      // null か既知の capability のどちらかであること (未定義の文字列を返さない)。
      const capability = workflowActionCapability(action);
      expect(capability === null || capability in CAPABILITY_MIN_ROLE).toBe(true);
    }
  });

  // ゲート対象のアクション名が語彙側で改名されると、 対応表のエントリが黙って死ぬ
  // (= 誰でもマージできる状態に戻る)。 実在する語彙であることを突き合わせておく。
  it("gates action names that actually exist in the emoji vocabulary", () => {
    for (const action of ["delegate-task", "merge-pr", "sync-project-main-after-merge"] as const) {
      expect(WORKFLOW_ACTIONS).toContain(action);
    }
  });

  it("names what is missing instead of failing silently", () => {
    expect(workflowDenialMessage("merge-pr", "merge_pr")).toContain("マージ");
    expect(workflowDenialMessage("delegate-task", "session_spawn")).toContain("セッション起動");
    expect(workflowDenialMessage("merge-pr", "merge_pr")).toContain("管理職");
  });

  // 要求役職は名簿の正本から引く。 どの capability でも文言が別の役職を名乗らない。
  it("states the required role from the roster for every capability", () => {
    for (const capability of STAFF_CAPABILITIES) {
      const expected = `${STAFF_ROLE_LABEL[CAPABILITY_MIN_ROLE[capability]]}以上`;
      expect(workflowDenialMessage("merge-pr", capability)).toContain(expected);
    }
  });

  it("keeps merge at 管理職 and never below session spawn", () => {
    expect(CAPABILITY_MIN_ROLE.merge_pr).toBe("manager");
    // readiness の人数は代表として session_spawn を数える。 両者の最低役職がずれると
    // 「押せるが merge できない」状態を見落とすので、 ここで固定しておく。
    expect(CAPABILITY_MIN_ROLE.session_spawn).toBe(CAPABILITY_MIN_ROLE.merge_pr);
    expect(capabilityAllowed("staff", "merge_pr")).toBe(false);
    expect(capabilityAllowed("manager", "merge_pr")).toBe(true);
  });
});

describe("reaction workflow action policies (2026-09-02 neco 指示)", () => {
  it("既定では Memoria 記録系だけ本社限定になる", () => {
    expect(workflowActionSubsidiaryAllowed("memoria-note")).toBe(false);
    expect(workflowActionSubsidiaryAllowed("memoria-task")).toBe(false);
    expect(workflowActionSubsidiaryAllowed("memoria-remaining")).toBe(false);
    expect(workflowActionSubsidiaryAllowed("context")).toBe(true);
    expect(workflowActionSubsidiaryAllowed("merge-pr")).toBe(true);
  });

  it("ポリシーで子会社可否と要求権限を上書きできる", () => {
    expect(workflowActionSubsidiaryAllowed("memoria-note", { "memoria-note": { subsidiary: true } })).toBe(true);
    expect(workflowActionSubsidiaryAllowed("context", { context: { subsidiary: false } })).toBe(false);
    expect(workflowActionCapability("merge-pr", { "merge-pr": { capability: "none" } })).toBeNull();
    expect(workflowActionCapability("context", { context: { capability: "session_spawn" } })).toBe("session_spawn");
    // 上書きが無い action は既定のまま。
    expect(workflowActionCapability("merge-pr", {})).toBe("merge_pr");
  });

  it("設定 GUI 向けの既定値ビューを返す", () => {
    expect(workflowActionDefaults("memoria-note")).toEqual({ subsidiary: false, capability: null });
    expect(workflowActionDefaults("merge-pr")).toEqual({ subsidiary: true, capability: "merge_pr" });
  });
});
