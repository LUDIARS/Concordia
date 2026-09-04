/**
 * 工程の状態遷移を 1 本のイベントにする。
 *
 * 遷移を書いている場所は 2 つある (API の `updateStep` と巡回の `advance` / `block`)。
 * それぞれが個別にカードを更新すると、 **片方だけ配線が漏れる**。 実際いまは巡回側から
 * カードへ繋ぐ経路が無く、 目標面が止まっていることを映さない。
 *
 * ここを通せば、 購読側 (Discord / Slack / WebUI) は 1 か所を見ればよい。
 *
 * @implements spec/feature/director-goal-flow.md 受け入れ基準 5
 */

import { eventBus, type ConcordiaEvent } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import type { DirectorStep, DirectorStepStatus } from "./types.js";

const log = createChildLogger("director-step-events");

/**
 * カードに見える状態が実際に変わったときだけ出す。blocked の補足はカード本文に出るため、
 * 同じ状態でも handoff_note が変われば更新対象になる。
 */
export function emitStepChanged(input: {
  step: DirectorStep;
  previousStatus: DirectorStepStatus;
  previousHandoffNote?: string | null;
  now?: () => number;
  emit?: (event: Extract<ConcordiaEvent, { type: "director.step_changed" }>) => void;
}): boolean {
  const statusChanged = input.step.status !== input.previousStatus;
  const blockedNoteChanged = input.step.status === "blocked"
    && input.step.handoff_note !== input.previousHandoffNote;
  if (!statusChanged && !blockedNoteChanged) return false;
  try {
    (input.emit ?? ((event) => eventBus.emit(event)))({
      type: "director.step_changed",
      case_id: input.step.case_id,
      step_id: input.step.id,
      status: input.step.status,
      previous_status: input.previousStatus,
      ts: (input.now ?? Date.now)(),
    });
  } catch (error) {
    // 通知は観測用。 遷移そのものは既に保存されている。
    log.warn({ err: (error as Error).message, step: input.step.id }, "step 遷移の通知に失敗した");
    return false;
  }
  return true;
}
