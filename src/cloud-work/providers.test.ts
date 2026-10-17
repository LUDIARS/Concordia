import { describe, expect, it, vi } from "vitest";
import { createClaudeCloudAdapter } from "./claude-adapter.js";
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

  it("fires the configured Claude routine without exposing the token in the packet", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ type: "routine_fire", claude_code_session_id: "session_123" }));
    const adapter = createClaudeCloudAdapter({ triggerId: "trig_123", environmentId: "test-env", fireToken: "test-only-secret" }, fetcher);
    await expect(adapter.submit(cloudSubmissionFixture("claude-cloud"))).resolves.toEqual({ state: "submitted", remoteId: "session_123" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/claude_code/routines/trig_123/fire");
    expect(init?.redirect).toBe("error");
    expect(init?.body).not.toContain("test-only-secret");
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-only-secret", "anthropic-beta": "experimental-cc-routine-2026-04-01" });
  });

  it.each([new Response("unavailable", { status: 503 }), Response.json({ ok: true }), new Response("x".repeat(16385))])("keeps rejected, oversized or unrecognized replies unknown", async (response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const adapter = createClaudeCloudAdapter({ triggerId: "trig_123", environmentId: "test-env", fireToken: "test-token" }, fetcher);
    await expect(adapter.submit(cloudSubmissionFixture("claude-cloud"))).resolves.toEqual({ state: "submission_unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not send a mismatched environment to a routine", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = createClaudeCloudAdapter({ triggerId: "trig_123", environmentId: "other", fireToken: "test-token" }, fetcher);
    await expect(adapter.submit(cloudSubmissionFixture("claude-cloud"))).rejects.toThrow("cloud_environment_mismatch");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
