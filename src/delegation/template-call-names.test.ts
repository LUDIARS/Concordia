import {describe,expect,it} from "vitest";
import {canonicalTemplateCallName, TEMPLATE_CALL_NAME_RENAMES} from "./template-call-names.js";

describe("standard profile aliases",()=>{
  it("resolves historic callers without restoring retired xhigh profiles",()=>{
    expect(canonicalTemplateCallName("sol-mid")).toBe("sol");
    expect(canonicalTemplateCallName("opus-5-5-movable")).toBe("opus");
    expect(canonicalTemplateCallName("fable-5-1-movable")).toBe("fable");
    expect(canonicalTemplateCallName("sonnet-mid")).toBe("sonnet");
    expect(canonicalTemplateCallName("sol-xhigh")).toBe("sol-xhigh");
    expect(canonicalTemplateCallName("custom-movable")).toBe("custom-movable");
  });

  it("maps versioned and retired-role names to role-based names",()=>{
    expect(canonicalTemplateCallName("opus-5-5")).toBe("opus");
    expect(canonicalTemplateCallName("sonnet-5-5")).toBe("sonnet");
    expect(canonicalTemplateCallName("fable-5-1")).toBe("fable");
    expect(canonicalTemplateCallName("sol-6-1")).toBe("sol");
    expect(canonicalTemplateCallName("terra-xhigh")).toBe("luna-xhigh");
    expect(canonicalTemplateCallName("claude-sonnet-5-ask")).toBe("sonnet-ask");
    expect(canonicalTemplateCallName("claude-sonnet-5-walk")).toBe("sonnet-walk");
    expect(canonicalTemplateCallName("design-hard-fable5")).toBe("design-hard-fable");
    expect(canonicalTemplateCallName("haiku")).toBe("haiku");
    expect(canonicalTemplateCallName("astra-mid")).toBe("astra-mid");
  });

  it("never chains: every target is a final name",()=>{
    const previous = new Set<string>(TEMPLATE_CALL_NAME_RENAMES.map(([from]) => from));
    for (const [, next] of TEMPLATE_CALL_NAME_RENAMES) expect(previous.has(next)).toBe(false);
  });
});
