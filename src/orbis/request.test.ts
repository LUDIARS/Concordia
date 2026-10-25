import { describe, expect, it } from "vitest";
import { ORBIS_OPERATIONS, parseOrbisRequest } from "./request.js";

describe("Orbis request policy", () => {
  it("defaults hidden open and text read, accepts the exact eight operations", () => {
    expect(ORBIS_OPERATIONS).toEqual(["attach", "detach", "open", "navigate", "read", "act", "logs", "reveal"]);
    expect(parseOrbisRequest("open", { sigillum: "human-seal", url: "https://example.test/?private=1" })).toMatchObject({ visible: false });
    expect(parseOrbisRequest("read", { sigillum: "human-seal" })).toMatchObject({ mode: "text" });
  });
  it.each([
    { type: "click", x: 10, y: 20 }, { type: "type", text: "あ".repeat(2000) },
    { type: "scroll", deltaY: -20 }, { type: "select", selector: "#choice", value: "yes" },
  ])("accepts supported action $type", action => {
    expect(parseOrbisRequest("act", { sigillum: "human-seal", action })).toMatchObject({ action });
  });
  it.each([
    { type: "evaluate", expression: "alert(1)" }, { type: "type", text: "x".repeat(2001) },
    { type: "click", x: Infinity, y: 1 }, { type: "type", text: "" }, { type: "scroll", script: "x" },
  ])("rejects invalid actions without echoing arguments", action => {
    expect(() => parseOrbisRequest("act", { sigillum: "human-seal", action })).toThrow(/^orbis_invalid_request$/);
  });
  it("rejects extra identity fields, unsupported modes and non-web URLs", () => {
    expect(() => parseOrbisRequest("attach", { sigillum: "s", session_id: "other" })).toThrow("orbis_invalid_request");
    expect(() => parseOrbisRequest("read", { sigillum: "s", mode: "cookies" })).toThrow("orbis_invalid_request");
    for (const url of ["file:///C:/private", "javascript:alert(1)"]) {
      expect(() => parseOrbisRequest("navigate", { sigillum: "s", url })).toThrow("orbis_invalid_request");
    }
  });
});
