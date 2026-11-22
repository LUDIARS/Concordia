/**
 * 指令の出来事 (登録・受領・回答・再配信) を、 後から差し込む受け手 (Discord の「muse-指令」チャンネル) へ流す
 * (spec/feature/agent-instructions-bridge.md CC-INST-INV-08)。
 *
 * 受け手は後追い・best-effort。 受け手が throw / reject しても、 指令の登録・ack・result は失敗させない (warn ログだけ)。
 * 受け手が未接続 (Bot 未起動・子会社 Bot) の間に起きた出来事は捨てる (溜めない)。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 指令の出来事
 */

import type { FinalStatus } from "./instruction-policy.js";

export type InstructionEvent =
  | { kind: "registered"; id: string; agent: string; type: string; title: string; body: string; createdAt: string }
  | { kind: "acked"; id: string; agent: string; title: string; ackedAt: string }
  | { kind: "finished"; id: string; agent: string; title: string; status: FinalStatus; summary: string; detail: string | null; finishedAt: string }
  | { kind: "requeued"; id: string; agent: string; title: string };

/** 受け手。 Promise を返してよい (待たない)。 */
export type InstructionEventListener = (event: InstructionEvent) => void | Promise<void>;

export interface InstructionEventRelay {
  emit(event: InstructionEvent): void;
  /** 受け手を差し替える。 null で外す。 */
  attach(listener: InstructionEventListener | null): void;
}

export function createInstructionEventRelay(log: { warn(detail: Record<string, unknown>, message: string): void }): InstructionEventRelay {
  let listener: InstructionEventListener | null = null;
  const warn = (event: InstructionEvent, error: unknown) => log.warn(
    { id: event.id, kind: event.kind, error: error instanceof Error ? error.message : String(error) },
    "agent instruction event could not be delivered",
  );
  return {
    emit(event) {
      const current = listener;
      if (!current) return;
      try {
        const pending = current(event);
        if (pending && typeof pending.then === "function") pending.then(undefined, (error: unknown) => warn(event, error));
      } catch (error) {
        warn(event, error);
      }
    },
    attach(next) {
      listener = next;
    },
  };
}
