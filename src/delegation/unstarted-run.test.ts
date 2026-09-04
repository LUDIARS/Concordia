/** @implements spec/tasks/2026-08-08-delegation-run-watchdog.md */
import { describe, expect, it } from "vitest";

import type { DelegationRunRow } from "../db/delegation-repo.js";
import { buildUnstartedInjectText, shouldReinjectUnstarted } from "./unstarted-run.js";

const NOW = 1_800_000_000_000;

describe("shouldReinjectUnstarted", () => {
  const base = { createdAtMs: NOW - 600_000, nowMs: NOW, thresholdMs: 300_000, lastNudgeMs: null };

  it("fires once the run has been silent for longer than the threshold", () => {
    expect(shouldReinjectUnstarted(base)).toBe(true);
  });

  it("waits while the run is still within the threshold", () => {
    expect(shouldReinjectUnstarted({ ...base, createdAtMs: NOW - 60_000 })).toBe(false);
  });

  it("keeps the same spacing between re-sends", () => {
    expect(shouldReinjectUnstarted({ ...base, lastNudgeMs: NOW - 60_000 })).toBe(false);
    expect(shouldReinjectUnstarted({ ...base, lastNudgeMs: NOW - 400_000 })).toBe(true);
  });

  it("is disabled by a non-positive threshold", () => {
    expect(shouldReinjectUnstarted({ ...base, thresholdMs: 0 })).toBe(false);
  });
});

describe("buildUnstartedInjectText", () => {
  const run = (overrides: Partial<DelegationRunRow>): DelegationRunRow => ({
    id: "run-9",
    prompt_file_path: "",
    ...overrides,
  } as DelegationRunRow);

  it("points the child at its own prompt file", () => {
    const text = buildUnstartedInjectText(run({ prompt_file_path: "E:/prompts/run-9.md" }));
    expect(text).toContain("E:/prompts/run-9.md");
    expect(text).toContain("/v1/delegation/runs/run-9/status");
  });

  it("asks for a failure report when the prompt file is gone", () => {
    const text = buildUnstartedInjectText(run({ prompt_file_path: "" }));
    expect(text).toContain("failed");
    expect(text).not.toContain("読み、");
  });
});
