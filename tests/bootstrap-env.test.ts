import { describe, expect, it } from "vitest";
import { readCcWorkflowEnabled, readPersonaInjectEnabled } from "../src/bootstrap/core.js";

describe("bootstrap env flags", () => {
  it("reads CONCORDIA_PERSONA_INJECT as opt-in only", () => {
    expect(readPersonaInjectEnabled({})).toBe(false);
    expect(readPersonaInjectEnabled({ CONCORDIA_PERSONA_INJECT: "0" })).toBe(false);
    expect(readPersonaInjectEnabled({ CONCORDIA_PERSONA_INJECT: "true" })).toBe(false);
    expect(readPersonaInjectEnabled({ CONCORDIA_PERSONA_INJECT: "1" })).toBe(true);
  });

  it("reads CONCORDIA_CC_WORKFLOW as opt-in only", () => {
    expect(readCcWorkflowEnabled({})).toBe(false);
    expect(readCcWorkflowEnabled({ CONCORDIA_CC_WORKFLOW: "0" })).toBe(false);
    expect(readCcWorkflowEnabled({ CONCORDIA_CC_WORKFLOW: "true" })).toBe(false);
    expect(readCcWorkflowEnabled({ CONCORDIA_CC_WORKFLOW: "1" })).toBe(true);
  });
});
