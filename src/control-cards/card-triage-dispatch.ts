/**
 * dots への card_triage 指令の登録と、回答の適用 (§3、実装メモ 7)。
 * 状態 (最後の指令・指紋・時刻) は設定ストアに 1 行で持つ。適用した捌きは `dots:<instruction id>` を残す。
 *
 * @implements spec/feature/control-cards.md — dots の捌き (CC-V5-INV-04)
 */
import type { InstructionEvent } from "../agent-instructions/instruction-events.js";
import type { RegisterInput } from "../agent-instructions/instruction-service.js";
import {
  buildTriageParams,
  decideTriageDispatch,
  triageFingerprint,
  validateTriageResult,
  type TriageApplication,
  type TriageDispatchDecision,
  type TriageDispatchState,
} from "./card-triage-policy.js";
import type { ControlCardsRepository } from "./repository.js";

export const TRIAGE_STATE_KEY = "control_cards.triage_state";

export interface TriageDispatchPorts {
  repo: ControlCardsRepository;
  isEnabled: () => boolean;
  state: { get(key: string): string | null; set(key: string, value: string): void };
  register: (input: RegisterInput) => { id: string };
  /** 指令の現在の状態。見つからなければ null。 */
  instructionStatus: (id: string) => string | null;
  now: () => number;
  log: { info(message: string): void; warn(message: string): void };
}

function readState(raw: string | null): TriageDispatchState {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<TriageDispatchState> | null;
    return {
      fingerprint: typeof value?.fingerprint === "string" ? value.fingerprint : null,
      instruction_id: typeof value?.instruction_id === "string" ? value.instruction_id : null,
      registered_at: typeof value?.registered_at === "number" ? value.registered_at : null,
    };
  } catch {
    return { fingerprint: null, instruction_id: null, registered_at: null };
  }
}

export function createTriageDispatch(ports: TriageDispatchPorts) {
  const state = () => readState(ports.state.get(TRIAGE_STATE_KEY));

  return {
    /** 巡回ごとに呼ぶ。積むべきときだけ 1 件登録する。 */
    tick(): TriageDispatchDecision {
      const open = ports.repo.listOpen();
      const current = state();
      const status = current.instruction_id ? ports.instructionStatus(current.instruction_id) : null;
      const nowMs = ports.now();
      const fingerprint = triageFingerprint(open);
      const decision = decideTriageDispatch({
        enabled: ports.isEnabled(), openCount: open.length, fingerprint, state: current,
        previousFinished: status === null || status === "done" || status === "failed", nowMs,
      });
      if (decision.kind !== "register") return decision;
      const params = buildTriageParams(open, nowMs);
      const registered = ports.register({
        agent: "dots",
        type: "card_triage",
        title: `管制カードの捌き (${open.length} 件)`,
        body: [
          "開いている管制カードの優先度・担当者・次の催促時刻・催促文・まとめ先を決めてください。",
          "変えられるのはこの 5 つだけです。カードの開閉・回答・セッションの操作はできません。",
          "回答は result.detail.cards[] に {card_id, priority, assignee?, remind_at?, reminder_text?, group?} で返してください。",
        ].join("\n"),
        params: params as unknown as Record<string, unknown>,
      });
      ports.state.set(TRIAGE_STATE_KEY, JSON.stringify({ fingerprint, instruction_id: registered.id, registered_at: nowMs }));
      ports.log.info(`card_triage registered ${registered.id} cards=${params.cards.length}`);
      return decision;
    },

    /** 指令ブリッジの出来事。この経路で積んだ dots の指令の done だけを適用する。 */
    onInstructionEvent(event: InstructionEvent): TriageApplication | null {
      if (event.kind !== "finished" || event.agent !== "dots" || event.status !== "done") return null;
      // 前の指令が終わるまで次を積まないので、この経路の指令は常に最後に記録した 1 件だけ。
      if (event.id !== state().instruction_id) return null;
      let detail: unknown = null;
      try { detail = event.detail === null ? null : JSON.parse(event.detail); } catch { detail = null; }
      const open = new Set(ports.repo.listOpen().map((card) => card.id));
      const nowMs = ports.now();
      const application = validateTriageResult(detail, open, nowMs);
      for (const item of application.apply) ports.repo.triage(item.cardId, item.patch, `dots:${event.id}`, nowMs);
      if (application.dropped.length) ports.log.warn(`card_triage ${event.id} dropped ${application.dropped.length} entries`);
      return application;
    },
  };
}

export type TriageDispatch = ReturnType<typeof createTriageDispatch>;
