import { beforeEach, expect, it, vi } from "vitest";
import { collectModelQuotaSnapshot } from "../delegation/model-tier-usage.js";
import { runClaude } from "./claude-runner.js";
import { runTextCodex } from "./patrol-codex-runner.js";
import { oneShotAvailability, runAvailableText } from "./available-text-runner.js";

vi.mock("../delegation/model-tier-usage.js", () => ({ collectModelQuotaSnapshot: vi.fn() }));
vi.mock("./claude-runner.js", () => ({ runClaude: vi.fn() }));
vi.mock("./patrol-codex-runner.js", () => ({ runTextCodex: vi.fn() }));
const snapshot = (quota: import("../delegation/model-tier-policy.js").ModelQuota) => ({ quota, observedAt: { claude: Date.now(), codex: Date.now() } });
const window = (used: number | null) => ({ used, reset: Math.floor(Date.now() / 1000) + 600 });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(collectModelQuotaSnapshot).mockResolvedValue(snapshot({ claude: [window(100)], codex: [window(20)] }));
  vi.mocked(runTextCodex).mockResolvedValue({ ok: true, stdout: "summary", stderr: "" });
  vi.mocked(runClaude).mockResolvedValue({ ok: true, stdout: "title", stderr: "", exit_code: 0, duration_ms: 1 });
});
it("routes exhausted Claude to Codex and preserves generated text", async () => {
  expect(await runAvailableText("input", { tier: "low" })).toMatchObject({ ok: true, stdout: "summary" });
  expect(runClaude).not.toHaveBeenCalled();
  expect(runTextCodex).toHaveBeenCalledWith("input", expect.objectContaining({ model: expect.stringContaining("luna"), purpose: "available-text" }));
});
it("uses tool-free Claude when Codex is exhausted", async () => {
  vi.mocked(collectModelQuotaSnapshot).mockResolvedValue(snapshot({ claude: [window(20)], codex: [window(100)] }));
  expect(await runAvailableText("input")).toMatchObject({ ok: true, stdout: "title" });
  expect(runClaude).toHaveBeenCalledWith("input", expect.objectContaining({ conversationOnly: true, model: expect.stringContaining("sonnet"), signal: expect.any(AbortSignal) }));
  expect(runTextCodex).not.toHaveBeenCalled();
});
it("retains unknown windows and fails closed without launching", async () => {
  const quota = { claude: [window(null)], codex: [] };
  expect(oneShotAvailability(quota, { claude: 123, codex: 123 }).claude?.windows?.[0].usedPercent).toBeNull();
  vi.mocked(collectModelQuotaSnapshot).mockResolvedValue(snapshot(quota));
  expect(await runAvailableText("input")).toMatchObject({ ok: false, stdout: "" });
  expect(runClaude).not.toHaveBeenCalled(); expect(runTextCodex).not.toHaveBeenCalled();
});
it("does not replay a failed execution on another provider", async () => {
  vi.mocked(runTextCodex).mockResolvedValue({ ok: false, stdout: "", stderr: "timeout" });
  expect(await runAvailableText("input")).toMatchObject({ ok: false, stderr: "timeout" });
  expect(runTextCodex).toHaveBeenCalledTimes(1); expect(runClaude).not.toHaveBeenCalled();
});
it("does not launch after cancellation during quota acquisition", async () => {
  const controller = new AbortController();
  vi.mocked(collectModelQuotaSnapshot).mockImplementation(async () => {
    controller.abort(); return snapshot({ claude: [window(10)], codex: [window(20)] });
  });
  expect(await runAvailableText("input", { signal: controller.signal })).toMatchObject({ ok: false });
  expect(runClaude).not.toHaveBeenCalled(); expect(runTextCodex).not.toHaveBeenCalled();
});
it("passes model-specific quota without treating unknown as absent", () => {
  const quota = { claude: [window(10)], codex: [window(20)], sonnet: window(null) };
  expect(oneShotAvailability(quota, { claude: 42, codex: 42 }).claude?.modelWindows?.sonnet).toEqual([{ usedPercent: null, resetsAt: quota.sonnet.reset }]);
});

it("does not refresh stale cached usage at selection time", async () => {
  vi.mocked(collectModelQuotaSnapshot).mockResolvedValue({ quota: { claude: [window(10)], codex: [window(20)] }, observedAt: { claude: Date.now() - 600000, codex: null } });
  expect(await runAvailableText("input")).toMatchObject({ ok: false });
  expect(runClaude).not.toHaveBeenCalled(); expect(runTextCodex).not.toHaveBeenCalled();
});
