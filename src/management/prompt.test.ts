import { describe, expect, it } from "vitest";
import type { ManagementRequest, Mission } from "./domain.js";
import { buildLaunchPrompt } from "./prompt.js";

const mission = { name: "CDGD", goal: "試遊の意見を改善へつなぐ" } as Mission;
const request = {
  id: "req-1", request_key: "r1", kind: "discussion", project_code: "Cf", target_key: "variant/1",
  purpose: "原因を議論する", completion_criteria: "原因候補が出る", rationale: "未議論の意見",
} as ManagementRequest;

describe("buildLaunchPrompt", () => {
  it("states that the request is AI-originated and not a human approval", () => {
    const text = buildLaunchPrompt(request, mission, "http://127.0.0.1:11111/");
    expect(text).toContain("人間の承認・正式採用ではありません");
    expect(text).toContain("原因を議論する");
    expect(text).toContain("完了条件: 原因候補が出る");
  });

  it("points the assignee at its own outcome endpoint without a trailing slash", () => {
    const text = buildLaunchPrompt(request, mission, "http://127.0.0.1:11111/");
    expect(text).toContain("POST http://127.0.0.1:11111/v1/management/requests/req-1/outcome");
    expect(text).toContain("受入待ちになるだけで、完了扱いにはなりません");
  });
});
