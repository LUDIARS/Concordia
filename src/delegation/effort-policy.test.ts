import { describe, expect, it } from "vitest";
import {
  baselineEffort,
  classifyTaskEffort,
  normalizeAutomaticEffort,
  supportsAutomaticEffort,
} from "./effort-policy.js";

describe("delegation effort policy", () => {
  it("codex ファミリ (codex / codex-sdk) と claude が自動 effort 対象", () => {
    expect(supportsAutomaticEffort("codex")).toBe(true);
    expect(supportsAutomaticEffort("codex-sdk")).toBe(true);
    expect(supportsAutomaticEffort("claude")).toBe(true);
    expect(supportsAutomaticEffort("gemini")).toBe(false);
    expect(supportsAutomaticEffort("gemma4-12")).toBe(false);
  });

  it("classifies routine, implementation, and complex prompts", () => {
    expect(classifyTaskEffort("Rename this label.")).toBe("routine");
    expect(classifyTaskEffort("Implement the API endpoint and tests.")).toBe("implementation");
    expect(classifyTaskEffort("Investigate the race condition and redesign the architecture.")).toBe("complex");
  });

  it("provides deterministic fallback levels", () => {
    expect(baselineEffort("routine")).toBe("low");
    expect(baselineEffort("implementation")).toBe("medium");
    expect(baselineEffort("complex")).toBe("xhigh");
  });

  it("accepts only the provider-common automatic levels", () => {
    expect(normalizeAutomaticEffort(" HIGH ")).toBe("high");
    expect(normalizeAutomaticEffort("max")).toBeNull();
    expect(normalizeAutomaticEffort("ultra")).toBeNull();
  });
});
