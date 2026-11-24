import type { DeskRequestView } from "../control/controlApi.js";

export const DESK_STATE_LABEL: Record<DeskRequestView["state"], string> = {
  accepted: "受付済み・起動待ち",
  launching: "起動中",
  launch_unknown: "起動結果を照合中",
  running: "作業中",
  finished: "セッション終了",
  launch_failed: "起動失敗",
};
