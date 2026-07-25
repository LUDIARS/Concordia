import { describe, expect, it, vi } from "vitest";
import type { RunClaudeFn } from "../rules/claude-runner.js";
import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import { selectForumDelegationTemplate } from "./forum-delegation-selector.js";

function candidate(callName: string): DelegationTemplateLite {
  return {
    call_name: callName,
    title: callName,
    description: `${callName} description`,
    target_provider: callName.includes("claude") ? "claude" : "codex",
    model: null,
    is_active: true,
    call_only: false,
    emoji: "",
    forum_tag: true,
    input_schema: [],
  };
}

describe("forum delegation selector", () => {
  it("runs Claude once with Sonnet and accepts an active forum_tag call_name", async () => {
    const runClaude = vi.fn(async () => ({
      ok: true,
      stdout: '{"call_name":"forum-codex"}',
      stderr: "",
    })) as unknown as RunClaudeFn;
    const templates = [candidate("forum-claude"), candidate("forum-codex")];

    const result = await selectForumDelegationTemplate(runClaude, {
      title: "[Cc] implement",
      body: "Please implement this",
      templates,
    });

    expect(result).toEqual({ ok: true, template: templates[1] });
    expect(runClaude).toHaveBeenCalledOnce();
    expect(runClaude).toHaveBeenCalledWith(
      expect.stringContaining('"call_name":"forum-codex"'),
      { model: "sonnet", timeoutMs: 45_000 },
    );
  });

  it.each([
    { output: '{"call_name":"not-a-candidate"}', label: "unknown call_name" },
    { output: "not-json", label: "invalid JSON" },
  ])("fails closed for $label", async ({ output }) => {
    const runClaude = vi.fn(async () => ({ ok: true, stdout: output, stderr: "" })) as unknown as RunClaudeFn;
    const result = await selectForumDelegationTemplate(runClaude, {
      title: "x",
      body: "y",
      templates: [candidate("forum-codex")],
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed when claude -p fails", async () => {
    const runClaude = vi.fn(async () => ({ ok: false, stdout: "", stderr: "offline" })) as unknown as RunClaudeFn;
    const result = await selectForumDelegationTemplate(runClaude, {
      title: "x",
      body: "y",
      templates: [candidate("forum-codex")],
    });
    expect(result).toEqual({ ok: false, error: "起動テンプレの選択に失敗しました。" });
  });
});
