/**
 * 管制の指示を既存の session.inject 経路で来歴付きに届ける。送る直前に送ってよい条件を確かめ直す。
 *
 * @implements spec/feature/control-session.md — 5. 指示の送り方 / CC-CTL-INV-05 / CC-CTL-INV-06
 */
import type { SessionRow } from "../shared/types.js";
import {
  checkInstructionEligibility,
  type EligibilityProbes,
  type IneligibleReason,
} from "./instruction-eligibility.js";

export const CONTROL_INJECT_SOURCE = "auto:control";

export type InstructionOrigin =
  | { kind: "control"; generation: number }
  | { kind: "patrol" }
  | { kind: "human"; label: string };

export interface InjectPort {
  canDeliver(event: ControlInjectEvent): boolean;
  emit(event: ControlInjectEvent): void;
}

export interface ControlInjectEvent {
  type: "session.inject";
  target_session_id: string;
  text: string;
  source: typeof CONTROL_INJECT_SOURCE;
  ts: number;
}

export interface DispatchResult {
  delivered: string[];
  skipped: Array<{ session_id: string; reason: IneligibleReason | "undeliverable" }>;
}

export function renderOriginHeader(origin: InstructionOrigin): string {
  if (origin.kind === "control") return `[管制] 管制セッション第 ${origin.generation} 世代からの追加指示です。`;
  if (origin.kind === "patrol") return "[管制] 管制の巡回からの追加指示です (止まっているセッションへの確認)。";
  return `[管制] ${origin.label} の一括指示です。`;
}

/** 来歴付きの本文。許可範囲は足さないことを明示する。 */
export function renderInstructionText(origin: InstructionOrigin, text: string): string {
  return [
    renderOriginHeader(origin),
    text.trim(),
    "この指示は新たな実行許可ではありません。審査ゲート・人間判断待ち・既存の許可範囲はそのまま守ってください。",
  ].join("\n");
}

export async function dispatchControlInstruction(input: {
  targets: readonly string[];
  text: string;
  origin: InstructionOrigin;
  findSession(sessionId: string): SessionRow | null;
  probes: EligibilityProbes;
  inject: InjectPort;
  nowMs: number;
}): Promise<DispatchResult> {
  const result: DispatchResult = { delivered: [], skipped: [] };
  const body = renderInstructionText(input.origin, input.text);
  for (const sessionId of [...new Set(input.targets)]) {
    const eligibility = await checkInstructionEligibility(input.findSession(sessionId), input.probes);
    if (!eligibility.ok) {
      result.skipped.push({ session_id: sessionId, reason: eligibility.reason });
      continue;
    }
    const event: ControlInjectEvent = {
      type: "session.inject", target_session_id: sessionId, text: body,
      source: CONTROL_INJECT_SOURCE, ts: Math.floor(input.nowMs / 1000),
    };
    // 届けられない (WS 未接続など) ものは送信済みにしない。
    if (!input.inject.canDeliver(event)) {
      result.skipped.push({ session_id: sessionId, reason: "undeliverable" });
      continue;
    }
    input.inject.emit(event);
    result.delivered.push(sessionId);
  }
  return result;
}
