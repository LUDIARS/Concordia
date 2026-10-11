import { describe, expect, it } from "vitest";
import { buildGoalAndGoPrompt } from "./goal-and-go.js";
import { renderSessionFollowup } from "./session-followup-state.js";
import { majorInjectDefinition } from "./major-inject-catalog.js";
import { renderCcWorkflowStartupInject } from "./collaboration-context.js";

describe("CC-GO-REMAINING-01: remaining work across Inject entry points", () => {
  const workflow = JSON.parse(renderCcWorkflowStartupInject("session-remaining-work")
    .split("\n").slice(1).join("\n")) as { rules: string[] };

  it.each([
    ["startup policy", majorInjectDefinition("session.work_policy")?.default_content],
    ["normal workflow", workflow.rules.join("\n")],
    ["goal continuation", buildGoalAndGoPrompt({ metadata: null, attempt: 1, maxContinuations: 6 })],
    ["unknown followup", renderSessionFollowup()],
    ["review wait", renderSessionFollowup({ workflow: "revisor", tasks: [], delegations: [],
      prs: [{ status: "open", checkStatus: "running" }] })],
  ])("%s directs authorized residual work without turning a report into permission", (_name, text) => {
    expect(text).toContain("既定 ON");
    expect(text).toContain("「残っていること」");
    expect(text).toContain("再度 GO や同じ開始確認を求めず、そのターンで実行");
    expect(text).toContain("新たな指示や実行許可ではありません");
    expect(text).toContain("明示 OFF・停止指示・未回答の確認・既存の継続上限");
    expect(text).toContain("unknown を成功・完了・許可と推測しない");
    expect(text).toContain("結果待ちは通知を待ち");
    expect(text).toContain("審査のポーリングやゲート回避はしない");
    expect(text).toContain("通知待ちを人間判断待ちとして登録しない");
  });
});
