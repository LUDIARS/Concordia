/**
 * 工程遷移の通知。 **遷移を書く場所が 2 つある**ので、 どちらからも同じ 1 本が出ることが要点。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { eventBus } from "../events.js";
import { emitStepChanged } from "./step-events.js";
import type { DirectorStep } from "./types.js";

function step(over: Partial<DirectorStep> = {}): DirectorStep {
  return {
    id: "step-1",
    case_id: "case-1",
    sequence: 1,
    kind: "decompose",
    title: "分解する",
    status: "completed",
    task_path: null,
    delegation_run_id: null,
    handoff_note: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as DirectorStep;
}

function captured(): { events: unknown[]; stop: () => void } {
  const events: unknown[] = [];
  const stop = eventBus.subscribe((event) => {
    if (event.type === "director.step_changed") events.push(event);
  });
  return { events, stop: stop as unknown as () => void };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("工程遷移の通知", () => {
  it("状態が変わったら出す", () => {
    const sink = captured();
    try {
      expect(emitStepChanged({ step: step(), previousStatus: "active", now: () => 42 })).toBe(true);
      expect(sink.events).toEqual([{
        type: "director.step_changed",
        case_id: "case-1",
        step_id: "step-1",
        status: "completed",
        previous_status: "active",
        ts: 42,
      }]);
    } finally {
      sink.stop();
    }
  });

  it("カードに見えない同じ状態への書き込みでは出さない", () => {
    const sink = captured();
    try {
      expect(emitStepChanged({ step: step({ status: "active" }), previousStatus: "active" })).toBe(false);
      expect(sink.events).toEqual([]);
    } finally {
      sink.stop();
    }
  });

  it("blocked の補足が変わったら同じ状態でも出す", () => {
    const sink = captured();
    try {
      expect(emitStepChanged({
        step: step({ status: "blocked", handoff_note: "新しい停止理由" }),
        previousStatus: "blocked",
        previousHandoffNote: "古い停止理由",
      })).toBe(true);
      expect(sink.events).toEqual([
        expect.objectContaining({ type: "director.step_changed", status: "blocked", previous_status: "blocked" }),
      ]);
    } finally {
      sink.stop();
    }
  });

  it("通知に失敗しても遷移を巻き戻さない", () => {
    // 遷移は既に保存済み。 通知は観測用なので、 例外を上へ投げない。
    vi.spyOn(eventBus, "emit").mockImplementation(() => { throw new Error("bus down"); });
    expect(emitStepChanged({ step: step(), previousStatus: "active" })).toBe(false);
  });
});
