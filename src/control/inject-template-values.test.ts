import { describe, expect, it } from "vitest";
import { injectSlot, renderCapturedInject } from "./inject-template-values.js";

describe("captured Inject placeholders", () => {
  it("renders dynamic content once without interpreting markers inside its value", () => {
    const values: Record<string, string> = {};
    const template = `before ${injectSlot(values, "task", "literal [[CC:secret]]") } after`;
    expect(renderCapturedInject(template, values)).toBe("before literal [[CC:secret]] after");
  });

  it("rejects a template with a placeholder that the builder did not supply", () => {
    expect(() => renderCapturedInject("[[CC:unknown]]", { task: "work" }))
      .toThrow("Unknown Inject placeholder: unknown");
  });

  it("rejects a template that drops a required captured value", () => {
    expect(() => renderCapturedInject("static prose", { task: "work" }))
      .toThrow("Missing Inject placeholder: task");
  });
});
