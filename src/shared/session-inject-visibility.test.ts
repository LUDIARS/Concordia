import {describe,it,expect} from "vitest";
import {shouldDisplaySessionInject} from "./session-inject-visibility.js";
import predicate from "./session-inject-visibility.contract.js";

describe("internal session-end display provenance",()=>{
  it("hides only the exact internal source",()=>{
    expect(shouldDisplaySessionInject("auto:session-end")).toBe(false);
    expect(predicate.post(false,"auto:session-end")).toBe(true);
    expect(predicate.post(true,"auto:session-end")).toBe(false);
  });
  it.each([undefined,null,"","auto:session-end:unknown"," auto:session-end ","discord:human","web:human","plan-approval"])(
    "retains other or unknown provenance %s",source=>{
      expect(shouldDisplaySessionInject(source)).toBe(true);
      expect(predicate.post(true,source)).toBe(true);
      expect(predicate.post(false,source)).toBe(false);
    });
});
