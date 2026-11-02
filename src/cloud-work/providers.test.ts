import { describe, expect, it, vi } from "vitest";
import { claudeCloudEnv, createClaudeCloudAdapter } from "./claude-adapter.js";
import type { CloudCliExecute } from "./cloud-cli-process.js";
import { createCodexCloudAdapter } from "./codex-adapter.js";
import { cloudSubmissionFixture } from "../../tests/helpers/cloud-submission-fixture.js";

describe("standard hosted provider adapters", () => {
  it("awaits private Git preparation before launching the provider", async () => {
    const run = vi.fn(async () => "https://chatgpt.com/codex/tasks/task_git\n");
    const adapter = createCodexCloudAdapter({ executable: "codex.exe", cwd: "workspace", publishedBranch: "main",
      transientInstructions: async () => "Prepared private Git return" }, run);
    await adapter.submit(cloudSubmissionFixture());
    const args = run.mock.calls[0] as unknown as [string, string[], string, string];
    expect(args[3]).toContain("Prepared private Git return");
    expect(args[3]).not.toContain("[object Promise]");
  });
  it("uses one shell-free Codex attempt and preserves the exact instruction argument", async () => {
    const run = vi.fn(async () => "https://chatgpt.com/codex/tasks/task_123\n");
    const adapter = createCodexCloudAdapter({ executable: "codex.exe", cwd: "workspace", publishedBranch: "main" }, run);
    const request = { ...cloudSubmissionFixture(), instruction: "Model $() ; --help 日本語" };
    await expect(adapter.submit(request)).resolves.toEqual({ state: "submitted", remoteId: "task_123" });
    const args = run.mock.calls[0] as unknown as [string, string[], string, string];
    expect(args[1]).toEqual(["cloud", "exec", "--env", "test-env", "--branch", "main", "--attempts", "1", "-"]);
    expect(args[3]).toContain(request.instruction);
    expect(args[3]).toContain(request.sourceRevision);
  });

  it.each(["", "success", "https://evil.example/codex/tasks/task_123", "https://chatgpt.com/codex/tasks/task_123?token=secret"])("does not infer success from arbitrary CLI output", async (stdout) => {
    const adapter = createCodexCloudAdapter({ executable: "codex.exe", cwd: "workspace", publishedBranch: "main" }, async () => stdout);
    await expect(adapter.submit(cloudSubmissionFixture())).resolves.toEqual({ state: "submission_unknown" });
  });

  it("rejects Windows shell wrappers", () => {
    expect(() => createCodexCloudAdapter({ executable: "codex.cmd", cwd: "workspace", publishedBranch: "main" })).toThrow();
  });

  it("creates a Claude cloud session from argv without secrets, then queues the transfer message on stdin", async () => {
    const run = vi.fn<CloudCliExecute>()
      .mockResolvedValueOnce("Created cloud session.\nView: https://claude.ai/code/session_01AbCdEfGh\n")
      .mockResolvedValueOnce(JSON.stringify({ ok: true, session_id: "session_01AbCdEfGh", url: "https://claude.ai/code/session_01AbCdEfGh" }));
    const adapter = createClaudeCloudAdapter({ executable: "claude.exe", cwd: "workspace",
      transientInstructions: async () => "Private upload URL test-only-secret" }, run);
    await expect(adapter.submit(cloudSubmissionFixture("claude-cloud"))).resolves.toEqual({ state: "submitted", remoteId: "session_01AbCdEfGh" });
    const [create, follow] = run.mock.calls;
    expect(create[1][0]).toBe("--cloud");
    expect(create[1].join(" ")).not.toContain("test-only-secret");
    expect(follow[1]).toEqual(["-p", "--cloud", "session_01AbCdEfGh", "--output-format", "json"]);
    expect(follow[3]).toContain("test-only-secret");
  });

  it.each(["", "done", "session_01AbCdEfGh and session_02ZyXwVuTs"])("does not infer a session from ambiguous CLI output: %j", async stdout => {
    const run = vi.fn<CloudCliExecute>().mockResolvedValue(stdout);
    const adapter = createClaudeCloudAdapter({ executable: "claude.exe", cwd: "workspace", transientInstructions: () => "secret" }, run);
    await expect(adapter.submit(cloudSubmissionFixture("claude-cloud"))).resolves.toEqual({ state: "submission_unknown" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports unknown when the transfer message was not confirmed for the created session", async () => {
    const run = vi.fn<CloudCliExecute>().mockResolvedValueOnce("https://claude.ai/code/session_01AbCdEfGh")
      .mockResolvedValueOnce(JSON.stringify({ ok: false, session_id: "session_01AbCdEfGh", error: "archived" }));
    const adapter = createClaudeCloudAdapter({ executable: "claude.exe", cwd: "workspace", transientInstructions: () => "secret" }, run);
    await expect(adapter.submit(cloudSubmissionFixture("claude-cloud"))).resolves.toEqual({ state: "submission_unknown" });
  });

  it("never prepares a session when transfer preparation fails, and rejects shell wrappers", async () => {
    const run = vi.fn<CloudCliExecute>();
    const adapter = createClaudeCloudAdapter({ executable: "claude.exe", cwd: "workspace",
      transientInstructions: async () => { throw new Error("cloud_git_access_binding_missing"); } }, run);
    await expect(adapter.submit(cloudSubmissionFixture("claude-cloud"))).rejects.toThrow("cloud_git_access_binding_missing");
    expect(run).not.toHaveBeenCalled();
    expect(() => createClaudeCloudAdapter({ executable: "claude.cmd", cwd: "workspace" })).toThrow("invalid_claude_cloud_configuration");
  });

  it("drops credentials that would override the claude.ai login", () => {
    expect(claudeCloudEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", PATH: "p" })).toEqual({ PATH: "p" });
  });
});
