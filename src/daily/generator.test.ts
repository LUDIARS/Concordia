import { expect, it, vi } from "vitest";
import { generateDayReport } from "./generator.js";
import { runAvailableText } from "../rules/available-text-runner.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
vi.mock("../config/claude-availability.js", () => ({ isClaudeDisabled: () => false }));
vi.mock("../rules/available-text-runner.js", () => ({ runAvailableText: vi.fn() }));
vi.mock("./aggregator.js", () => ({
  dayRange: () => ({ startTs: 0, endTs: 1 }),
  aggregateDay: () => ({ date_iso: "2026-10-22", session_count: 1, total_duration_sec: 10, projects: [], roles: [], outcomes: {} }),
}));
it("publishes a provider-neutral narrative with the existing report shape", async () => {
  const summary = "A complete daily narrative that describes the work performed.";
  vi.mocked(runAvailableText).mockResolvedValue({ ok: true, stdout: summary, stderr: "", exit_code: 0, duration_ms: 1 });
  const repo = { listSessionsInRange: () => [] } as unknown as SessionsRepo;
  expect(await generateDayReport("2026-10-22", repo)).toMatchObject({ summary_md: summary, session_count: 1 });
  expect(runAvailableText).toHaveBeenCalledTimes(1);
});
