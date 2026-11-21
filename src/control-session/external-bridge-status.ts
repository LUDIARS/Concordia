import { contract } from '../harness/reliability/ontime-runtime.js'; /* augur-inject:import:cfd4b1e8 */
import augurContract_af3c7ba5 from './external-bridge-status.contract.js'; /* augur-inject:contract-predicate:e54396f1 */
export interface ExternalBridgeObservation {
  configured: boolean;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_reason: string | null;
  pending?: number;
  running?: number;
}

export type ExternalBridgeId = "muse" | "conflux" | "playtest_review";
export type ExternalBridgeStatus = "unconfigured" | "unused" | "healthy" | "failed";
export type ExternalBridge =
  | (ExternalBridgeObservation & { id: ExternalBridgeId; status: ExternalBridgeStatus })
  | { id: ExternalBridgeId; status: "unavailable" };
export type ExternalBridgeReader = () => ExternalBridge[];

export function externalBridgeStatus(input: ExternalBridgeObservation): ExternalBridgeStatus {
  if (!input.configured) return "unconfigured";
  const { last_failure_at: failed, last_success_at: success } = input;
  if (failed && (!success || Date.parse(failed) >= Date.parse(success))) return "failed";
  return success ? "healthy" : "unused";
}
// @ts-expect-error augur-inject
externalBridgeStatus = contract(externalBridgeStatus, { ...augurContract_af3c7ba5, contractId: 'gen5-return-C-2', mode: 'observe', sample: 1, where: 'src/control-session/external-bridge-status.ts:17', rule: 'contract-wrap', id: 'af3c7ba5' }); /* augur-inject:contract-wrap:af3c7ba5 */

export function readExternalBridges(
  readers: Record<ExternalBridgeId, () => ExternalBridgeObservation>,
  warn: (message: string) => void,
): ExternalBridge[] {
  return (Object.keys(readers) as ExternalBridgeId[]).map((id) => {
    try {
      const observation = readers[id]();
      return { ...observation, id, status: externalBridgeStatus(observation) };
    } catch {
      warn(`Could not read external bridge evidence: ${id}`);
      return { id, status: "unavailable" };
    }
  });
}

const labels: Record<ExternalBridgeId, string> = {
  muse: "Muse 指令ブリッジ", conflux: "Conflux 外部通知フック", playtest_review: "Playtest Review 受け口",
};
const statuses: Record<ExternalBridgeStatus, string> = {
  unconfigured: "未接続（未設定）", unused: "未使用（実績なし）", healthy: "正常", failed: "失敗あり",
};

export function renderExternalBridgeLines(bridges: readonly ExternalBridge[]): string[] {
  if (bridges.length === 0) return [];
  return ["外部連携", ...bridges.map((bridge) => {
    if (bridge.status === "unavailable") return `- ${labels[bridge.id]} / 状況取得失敗`;
    const reason = bridge.last_failure_reason?.replace(/[\r\n<>\x60]/g, " ").slice(0, 120);
    const lastFailure = bridge.last_failure_at ? `${bridge.last_failure_at}${reason ? ` (${reason})` : ""}` : "なし";
    const counts = bridge.pending === undefined ? "" : ` / 保留 ${bridge.pending} / 実行中 ${bridge.running ?? 0}`;
    return `- ${labels[bridge.id]} / ${statuses[bridge.status]} / 最終成功 ${bridge.last_success_at ?? "なし"} / 最終失敗 ${lastFailure}${counts}`;
  })];
}
