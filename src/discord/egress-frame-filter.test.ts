import { describe, expect, it } from "vitest";
import { isRelayCandidateFrame, type TranscriptFrameEvent } from "./egress-frame-filter.js";

function frame(kind: string, payload: unknown): TranscriptFrameEvent {
  return { type: "transcript.frame", target_session_id: "s1", seq: 1, kind, payload, ts: 0 };
}

describe("isRelayCandidateFrame", () => {
  it("assistant text は候補", () => {
    expect(isRelayCandidateFrame(frame("text", { role: "assistant", text: "回答" }))).toBe(true);
  });

  it("user / tool の text は候補外", () => {
    expect(isRelayCandidateFrame(frame("text", { role: "user", text: "指示" }))).toBe(false);
    expect(isRelayCandidateFrame(frame("text", { role: "tool", text: "x" }))).toBe(false);
  });

  it("空 text / payload 欠落は候補外", () => {
    expect(isRelayCandidateFrame(frame("text", { role: "assistant", text: "" }))).toBe(false);
    expect(isRelayCandidateFrame(frame("text", null))).toBe(false);
  });

  it("summary は text か summary があれば候補", () => {
    expect(isRelayCandidateFrame(frame("summary", { text: "要約" }))).toBe(true);
    expect(isRelayCandidateFrame(frame("summary", { summary: "要約" }))).toBe(true);
    expect(isRelayCandidateFrame(frame("summary", {}))).toBe(false);
  });

  it("image は data があれば候補", () => {
    expect(isRelayCandidateFrame(frame("image", { media_type: "image/png", data: "aGk=" }))).toBe(true);
    expect(isRelayCandidateFrame(frame("image", {}))).toBe(false);
  });

  it("tool-use / thinking / raw は候補外", () => {
    expect(isRelayCandidateFrame(frame("tool-use", { name: "Bash" }))).toBe(false);
    expect(isRelayCandidateFrame(frame("thinking", { text: "…" }))).toBe(false);
    expect(isRelayCandidateFrame(frame("raw", { anything: 1 }))).toBe(false);
  });
});
