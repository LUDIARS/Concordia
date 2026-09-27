import { expect, it } from "vitest";
import { addMissingPresets, RWF_PRESETS } from "./reaction-workflow-presets.js";
it("preserves custom prompts and variant emoji assignments, and skips unavailable skills", () => {
  const existing = [{ emoji: "🧠️", label: "mine", prompt: "existing" }];
  const result = addMissingPresets(existing, new Set(["context-report", "handoff"]));
  expect(result).toEqual([existing[0], RWF_PRESETS[2]]);
  expect(addMissingPresets(result, new Set(["context-report", "handoff"]))).toEqual(result);
});
