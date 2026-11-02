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

  const claudeConfig = { triggerId: "trig_123", fireToken: "test-only-fire-token", executable: "claude.exe", cwd: "workspace" };
  const fired = () => Response.json({ type: "routine_fire", claude_code_session_id: "session_01AbCdEfGh" });

  it("creates the session by routine fire with public data, then queues the transfer message on stdin", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(fired());
    const run = vi.fn<CloudCliExecute>().mockResolvedValue(JSON.stringify({ ok: true, session_id: "session_01AbCdEfGh" }));
    const adapter = createClaudeCloudAdapter({ ...claudeConfig, transientInstructions: async () => "Private upload URL test-only-secret" }, { fetcher, run });
    await expect(adapter.submit(cloudSubmissionFixture("claude-cloud"))).resolves.toEqual({ state: "submitted", remoteId: "session_01AbCdEfGh" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/claude_code/routines/trig_123/fire");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-only-fire-token", "anthropic-beta": "experimental-cc-routine-2026-04-01" });
    expect(String(init?.body)).not.toContain("test-only-secret");
    expect(String(init?.body)).not.toContain("test-only-fire-token");
    const follow = run.mock.calls[0];
    expect(follow[1]).toEqual(["-p", "--cloud", "session_01AbCdEfGh", "--output-format", "json"]);
    expect(follow[3]).toContain("test-only-secret");
  });

  it("does not need the CLI when no transfer message is required", async () => {
    const run = vi.fn<CloudCliExecute>();
    const adapter = createClaudeCloudAdapter(claudeConfig, { fetcher: vi.fn<typeof fetch>().mockResolvedValue(fired()), run });
    await expect(adapter.submit(cloudSubmissionFixture("claude-cloud"))).resolves.toEqual({ state: "submitted", remoteId: "session_01AbCdEfGh" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([new Response("unavailable", { status: 503 }), Response.json({ ok: true }), new Response("x".repeat(16385))])(
    "keeps rejected, oversized or unrecognized routine replies unknown without a follow-up", async response => {
      const run = vi.fn<CloudCliExecute>();
      const adapter = createClaudeCloudAdapter({ ...claudeConfig, transientInstructions: () => "secret" },
        { fetcher: vi.fn<typeof fetch>().mockResolvedValue(response), run });
      await expect(adapter.submit(cloudSubmissionFixture("claude-cloud"))).resolves.toEqual({ state: "submission_unknown" });
      expect(run).not.toHaveBeenCalled();
    });

  it("reports unknown when the transfer message was not confirmed for the created session", async () => {
    const run = vi.fn<CloudCliExecute>().mockResolvedValue(JSON.stringify({ ok: false, session_id: "session_01AbCdEfGh", error: "archived" }));
    const adapter = createClaudeCloudAdapter({ ...claudeConfig, transientInstructions: () => "secret" },
      { fetcher: vi.fn<typeof fetch>().mockResolvedValue(fired()), run });
    await expect(adapter.submit(cloudSubmissionFixture("claude-cloud"))).resolves.toEqual({ state: "submission_unknown" });
  });

  it("fires nothing when transfer preparation fails, and rejects shell wrappers or bad triggers", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = createClaudeCloudAdapter({ ...claudeConfig,
      transientInstructions: async () => { throw new Error("cloud_git_access_binding_missing"); } }, { fetcher });
    await expect(adapter.submit(cloudSubmissionFixture("claude-cloud"))).rejects.toThrow("cloud_git_access_binding_missing");
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => createClaudeCloudAdapter({ ...claudeConfig, executable: "claude.cmd" })).toThrow("invalid_claude_cloud_configuration");
    expect(() => createClaudeCloudAdapter({ ...claudeConfig, triggerId: "bad" })).toThrow("invalid_claude_cloud_configuration");
  });

  it("drops credentials that would override the claude.ai login", () => {
    expect(claudeCloudEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", PATH: "p" })).toEqual({ PATH: "p" });
  });
});
