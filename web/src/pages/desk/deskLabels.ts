import type { DeskRequestView } from "../control/controlApi.js";

export const DESK_STATE_LABEL: Record<DeskRequestView["state"], string> = {
  accepted: "受付済み・起動待ち",
  launching: "起動中",
  launch_unknown: "起動結果を照合中",
  running: "作業中",
  finished: "セッション終了",
  launch_failed: "起動失敗",
};

export function deskStateLabel(request: DeskRequestView): string {
  if (request.routing_issue === "project") return "対象プロジェクトの選択待ち";
  if (request.routing_issue === "delivery") return "管制・委託の確認待ち";
  if (request.task_reference && request.state === "accepted") return "Actio 登録済み・管制待ち";
  if (request.task_reference && request.state === "running") {
    if (request.delegation_run_id) return "委託済み";
    return request.delivery === "claimed" ? "管制受付済み・委託待ち" : "プロジェクト管制の受付待ち";
  }
  if (request.task_reference && request.state === "finished") return "Actio タスク終了";
  return DESK_STATE_LABEL[request.state];
}
