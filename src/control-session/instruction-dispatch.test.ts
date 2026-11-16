import { describe, expect, it } from "vitest";
import type { SessionRow } from "../shared/types.js";
import type { EligibilityProbes } from "./instruction-eligibility.js";
import {
  CONTROL_INJECT_SOURCE,
  dispatchControlInstruction,
  renderInstructionText,
  type ControlInjectEvent,
} from "./instruction-dispatch.js";

const sessions: Record<string, SessionRow> = {
  a: { id: "a", status: "active", metadata: null } as SessionRow,
  b: { id: "b", status: "active", metadata: null } as SessionRow,
  q: { id: "q", status: "active", metadata: null } as SessionRow,
};

const probes: EligibilityProbes = {
  isControlSession: () => false,
  isAutoCheckDisabled: () => false,
  hasPendingQuestion: (id) => id === "q",
  isHumanWaitActive: () => false,
  isWaitingForHumanResponse: () => false,
  isAwaitingAsk: async () => false,
};

describe("dispatchControlInstruction (CC-CTL-INV-06)", () => {
  it("delivers through session.inject with provenance and skips waiting sessions", async () => {
    const emitted: ControlInjectEvent[] = [];
    const result = await dispatchControlInstruction({
      targets: ["a", "q", "a", "missing"], text: "テストを足してください",
      origin: { kind: "control", generation: 3 },
      findSession: (id) => sessions[id] ?? null, probes,
      inject: { canDeliver: () => true, emit: (event) => emitted.push(event) }, nowMs: 5000,
    });
    expect(result.delivered).toEqual(["a"]);
    expect(result.skipped).toEqual([
      { session_id: "q", reason: "pending_question" },
      { session_id: "missing", reason: "not_active" },
    ]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "session.inject", target_session_id: "a", source: CONTROL_INJECT_SOURCE, ts: 5 });
    expect(emitted[0].text).toContain("管制セッション第 3 世代");
    expect(emitted[0].text).toContain("新たな実行許可ではありません");
  });

  it("does not record undeliverable sessions as sent", async () => {
    const result = await dispatchControlInstruction({
      targets: ["b"], text: "x", origin: { kind: "human", label: "neco" },
      findSession: (id) => sessions[id] ?? null, probes,
      inject: { canDeliver: () => false, emit: () => { throw new Error("must not emit"); } }, nowMs: 0,
    });
    expect(result).toEqual({ delivered: [], skipped: [{ session_id: "b", reason: "undeliverable" }] });
  });

  it("names the human sender of a bulk instruction", () => {
    expect(renderInstructionText({ kind: "human", label: "neco" }, " 進めて ")).toMatch(/^\[管制\] neco の一括指示です。\n進めて\n/);
  });
});
