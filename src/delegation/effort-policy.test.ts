import { describe, expect, it } from "vitest";
import { baselineEffort, classifyEffortTask, normalizeAutomaticEffort } from "./effort-policy.js";

describe("delegation effort policy", () => {
  it("classifies routine, implementation, and complex prompts", () => {
    expect(classifyEffortTask("Rename this label.")).toBe("routine");
    expect(classifyEffortTask("Implement the API endpoint and tests.")).toBe("implementation");
    expect(classifyEffortTask("Investigate the race condition and redesign the architecture.")).toBe("complex");
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
