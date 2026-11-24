/**
 * 「Muse 指令」の行の詳細に出す、 Muse の試遊結果の中継の状態 (表示だけ)
 * (spec/feature/playtest-review-notify.md — Muse の結果の中継)。 保存: 記録 ID / 失敗理由、 告知: delivered / failed。
 *
 * @implements spec/feature/playtest-review-notify.md — Muse の結果の中継
 */

import type { RelayState } from "./history-api.js";

const SAVE_LABEL: Record<RelayState["voluptasState"], string> = {
  pending: "保存待ち (再試行中)",
  saved: "保存済み",
  failed: "保存失敗",
  skipped: "保存なし",
};
const ANNOUNCE_LABEL: Record<RelayState["announceState"], string> = {
  pending: "告知待ち",
  announcing: "告知中",
  delivered: "delivered",
  failed: "failed",
  skipped: "告知なし",
};

function announceDetail(relay: RelayState): string {
  const summary = relay.announce;
  if (!summary) return "";
  if (summary.duplicate) return " (同じ run を受付済み)";
  if (summary.unconfigured) return " (宛先未設定)";
  const tabula = summary.tabula === "posted" ? " + Tabula" : summary.tabula === "failed" ? " / Tabula 失敗" : "";
  return ` (${summary.delivered} 件${tabula}${summary.failed > 0 ? ` / 届かなかった ${summary.failed} 件` : ""})`;
}

export function RelayStatus({ relay }: { relay: RelayState }) {
  return (
    <div data-testid="relay-status">
      <div className="text-subtle">中継 (Voluptas 保存と告知)</div>
      <div>
        保存: {SAVE_LABEL[relay.voluptasState]}
        {relay.voluptasId ? ` ${relay.voluptasId}` : ""}
        {relay.attempts > 0 ? ` / 試行 ${relay.attempts} 回` : ""}
      </div>
      <div>告知: {ANNOUNCE_LABEL[relay.announceState]}{announceDetail(relay)}</div>
      {relay.error && <div className="text-danger">理由: {relay.error}</div>}
    </div>
  );
}
