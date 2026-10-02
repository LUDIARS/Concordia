import { describe, expect, it } from "vitest";
import { BUDGET_RESUME_CALL_NAME, planBudgetResumeLaunch } from "./budget-resume-launch.js";

const CONVERSATION = "9914dcf2-7e21-4fcd-96ae-7dfe7c64d662";

describe("planBudgetResumeLaunch", () => {
  it("同じ cwd・テンプレート・部署・チーム・依頼者とモデルで claude --resume を起動する", () => {
    const plan = planBudgetResumeLaunch({
      session: {
        id: "lictor-1",
        provider: "claude-code",
        team_id: "team_a",
        department_id: "dept_a",
        metadata: JSON.stringify({
          model: "claude-opus-5-5", effort: "medium", delegation_call_name: "opus-5-5-movable",
          discord_requester_user_id: "111111111", discord_source_channel_id: "555555555", subsidiary_id: "sub_a",
        }),
      },
      conversationId: CONVERSATION,
      cwd: "E:/Document/Ars",
      consultWorkspaceRoot: null,
    });
    expect(plan).toMatchObject({
      ok: true,
      spawn: {
        provider: "claude",
        cwd: "E:/Document/Ars",
        args: ["--resume", CONVERSATION, "--model", "claude-opus-5-5", "--effort", "medium"],
        env: { CONCORDIA_TEAM_ID: "team_a" },
      },
      pending: {
        callName: "opus-5-5-movable", departmentId: "dept_a", teamId: "team_a",
        requesterDiscordUserId: "111111111", sourceDiscordChannelId: "555555555", subsidiaryId: "sub_a",
      },
    });
  });

  it("相談部署は相談専用の設定フォルダとツール制限を同じに付ける", () => {
    const plan = planBudgetResumeLaunch({
      session: { id: "lictor-2", provider: "claude-code", metadata: JSON.stringify({ discord_requester_user_id: "111111111" }) },
      conversationId: CONVERSATION,
      cwd: "E:/consult/engineer",
      consultWorkspaceRoot: "E:/consult",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.spawn.args).toEqual(expect.arrayContaining(["--resume", CONVERSATION, "--strict-mcp-config"]));
    expect(plan.spawn.env).toMatchObject({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    expect(plan.spawn.env?.CLAUDE_CONFIG_DIR).toContain(".claude-config");
    expect(plan.spawn.env?.CONCORDIA_CONSULT_DATA_DIR).toContain("111111111");
    expect(plan.pending.callName).toBe(BUDGET_RESUME_CALL_NAME);
  });

  it("claude 以外のセッションは再開しない", () => {
    expect(planBudgetResumeLaunch({
      session: { id: "x", provider: "codex-cli", metadata: null }, conversationId: CONVERSATION, cwd: "E:/", consultWorkspaceRoot: null,
    })).toEqual({ ok: false, error: "resume_requires_claude" });
  });
});
