import {describe,expect,it} from "vitest";
import {canonicalTemplateCallName} from "./template-call-names.js";

describe("standard profile aliases",()=>{
  it("resolves historic callers without restoring retired xhigh profiles",()=>{
    expect(canonicalTemplateCallName("sol-mid")).toBe("sol-6-1");
    expect(canonicalTemplateCallName("opus-5-5-movable")).toBe("opus-5-5");
    expect(canonicalTemplateCallName("fable-5-1-movable")).toBe("fable-5-1");
    expect(canonicalTemplateCallName("sonnet-mid")).toBe("sonnet-5-5");
    expect(canonicalTemplateCallName("sol-xhigh")).toBe("sol-xhigh");
    expect(canonicalTemplateCallName("custom-movable")).toBe("custom-movable");
  });
});
