import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectForumModelUsage } from "../delegation/forum-model-usage.js";
import { runClaude } from "./claude-runner.js";
import { runPatrolCodex } from "./patrol-codex-runner.js";
import { runPatrolText } from "./patrol-text-runner.js";

vi.mock("../delegation/forum-model-usage.js", () => ({ collectForumModelUsage: vi.fn() }));
vi.mock("./claude-runner.js", () => ({ runClaude: vi.fn() }));
vi.mock("./patrol-codex-runner.js", () => ({ runPatrolCodex: vi.fn() }));
const opts = { model: "haiku", timeoutMs: 30_000, conversationOnly: true as const };
const result = { ok: true, stdout: "本文", stderr: "" };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(runPatrolCodex).mockResolvedValue(result); });
describe("patrol provider dispatch", () => {
  it("uses Luna when Claude is exhausted and never invokes the Claude process", async () => {
    vi.mocked(collectForumModelUsage).mockResolvedValue({
      claudeWeekly: { usedPct: 100, resetAtSec: null },
      codexWeekly: { usedPct: 20, resetAtSec: null }, fableUsedPct: null,
    });
    expect(await runPatrolText("prompt", opts)).toEqual(result);
    expect(runPatrolCodex).toHaveBeenCalledWith("prompt", 30_000);
    expect(runClaude).not.toHaveBeenCalled();
  });
  it("uses Claude when it is the only provider above the threshold", async () => {
    vi.mocked(collectForumModelUsage).mockResolvedValue({
      claudeWeekly: { usedPct: 50, resetAtSec: null },
      codexWeekly: { usedPct: 80, resetAtSec: null }, fableUsedPct: null,
    });
    await runPatrolText("prompt", opts);
    expect(runClaude).toHaveBeenCalledWith("prompt", opts);
    expect(runPatrolCodex).not.toHaveBeenCalled();
  });
  it("does not invent quota or retry on another provider after a failed generation", async () => {
    vi.mocked(collectForumModelUsage).mockResolvedValue({
      claudeWeekly: null, codexWeekly: null, fableUsedPct: null,
    });
    await expect(runPatrolText("prompt", opts)).rejects.toThrow("patrol_quota_unavailable");
    expect(runClaude).not.toHaveBeenCalled();
    expect(runPatrolCodex).not.toHaveBeenCalled();
    vi.mocked(collectForumModelUsage).mockResolvedValue({
      claudeWeekly: { usedPct: 100, resetAtSec: null },
      codexWeekly: { usedPct: 20, resetAtSec: null }, fableUsedPct: null,
    });
    vi.mocked(runPatrolCodex).mockResolvedValue({ ok: false, stdout: "", stderr: "timeout" });
    expect((await runPatrolText("prompt", opts)).ok).toBe(false);
    expect(runClaude).not.toHaveBeenCalled();
  });
});
