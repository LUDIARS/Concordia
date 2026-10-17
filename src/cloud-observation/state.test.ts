import { describe, expect, it } from "vitest";
import { answerObservation, applyObservation, initialObservation, observationLiveness } from "./state.js";

describe("cloud observation policy", () => {
  const event = { id: "first", sequence: 1, kind: "progress", message: "Building walls" };
  it("uses receipt time and does not turn silence into completion", () => {
    const state = applyObservation(initialObservation(), event, 1000);
    expect(observationLiveness(state, 180999)).toBe("recent");
    expect(observationLiveness(state, 181000)).toBe("disconnected");
    expect(state.phase).toBe("working");
    expect(observationLiveness(initialObservation(), 0)).toBe("unobserved");
  });
  it("does not extend liveness for replays or accept changed and out-of-order events", () => {
    const state = applyObservation(initialObservation(), event, 1000);
    expect(applyObservation(state, event, 9000)).toBe(state);
    expect(() => applyObservation(state, { ...event, message: "Changed" }, 2000)).toThrow("replay_conflict");
    expect(() => applyObservation(state, { ...event, id: "old" }, 2000)).toThrow("sequence_conflict");
  });
  it("keeps a question pending through heartbeats and requires a matching answer", () => {
    const waiting = applyObservation(initialObservation(), { ...event, kind: "question", questionId: "height" }, 1000);
    const alive = applyObservation(waiting, { id: "beat", sequence: 2, kind: "heartbeat" }, 2000);
    expect(alive.phase).toBe("waiting_answer");
    expect(() => applyObservation(alive, { ...event, id: "done", sequence: 3, kind: "finished" }, 3000)).toThrow("answer_required");
    expect(() => answerObservation(alive, "wrong", "10 floors", "123", 3000)).toThrow("not_pending");
    const answered = answerObservation(alive, "height", "10 floors", "123", 3000);
    expect(answered.phase).toBe("answer_ready");
    expect(applyObservation(answered, { id: "beat3", sequence: 3, kind: "heartbeat" }, 4000).phase).toBe("answer_ready");
    expect(answered.question?.answer?.text).toBe("10 floors");
    expect(() => answerObservation(answered, "height", "20 floors", "123", 4000)).toThrow("not_pending");
  });
  it("treats a remote finish as reported, and disallows further events", () => {
    const state = applyObservation(initialObservation(), { ...event, kind: "finished" }, 1000);
    expect(state.phase).toBe("reported_finished");
    expect(() => applyObservation(state, { id: "beat", sequence: 2, kind: "heartbeat" }, 2000)).toThrow("terminal");
  });
  it("rejects an old event ID reused with a new sequence", () => {
    let state = applyObservation(initialObservation(), event, 1000);
    state = applyObservation(state, { id: "second", sequence: 2, kind: "heartbeat" }, 2000);
    expect(() => applyObservation(state, { ...event, sequence: 3 }, 3000)).toThrow("event_reused");
  });
  it("rejects arbitrary preview URLs, invalid event fields and empty questions", () => {
    expect(() => applyObservation(initialObservation(), { ...event, kind: "preview", previewId: "https://host/file" }, 0)).toThrow();
    expect(() => applyObservation(initialObservation(), { ...event, kind: "question", questionId: "q", message: " " }, 0)).toThrow();
    expect(() => applyObservation(initialObservation(), { ...event, webhook: "private" }, 0)).toThrow();
  });
});
