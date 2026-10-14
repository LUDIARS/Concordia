/**
 * 1 時間ごとのワンショット確認の判断 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 4. 1 時間ごとのワンショット確認 / 6. 終わり方 (ゴール到達) / CC-DG-INV-03 / CC-DG-INV-05
 *
 * 判定 (LLM) の出力は信用しない。 状態が既知の 3 値でなければ捨て、 受入条件ごとの根拠は
 * Cc が集めた証跡に実在するキーだけを残す。 実在の根拠が無い「到達」は「見込みあり」に落とす。
 * 到達の照合は stop-policy の evaluateGoalReached に委ねる。
 */

import { evaluateGoalReached } from "./stop-policy.js";
import {
  ACCEPTANCE_OUTLOOKS,
  PROGRESS_VERDICTS,
  isActiveGoal,
  type AcceptanceOutlook,
  type DailyGoal,
  type EvidenceSnapshot,
  type ProgressJudgment,
  type ProgressVerdict,
} from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:104e4903 */
import augurContract_8c1aa290 from './normalize-judgment.contract.js'; /* augur-inject:contract-predicate:d9bffa8d */

export const DEFAULT_CHECKPOINT_MINUTES = 60;
const REASON_LIMIT = 300;

/** 判定 (LLM) が返した形のまま。 acceptance[].index は受入条件の 1 始まりの番号。 */
export interface RawJudgment {
  verdict?: unknown;
  reason?: unknown;
  acceptance?: unknown;
}

function isVerdict(value: unknown): value is ProgressVerdict {
  return typeof value === "string" && (PROGRESS_VERDICTS as readonly string[]).includes(value);
}

function isOutlook(value: unknown): value is AcceptanceOutlook {
  return typeof value === "string" && (ACCEPTANCE_OUTLOOKS as readonly string[]).includes(value);
}

/**
 * 判定を正規化する。 状態が順調・遅れ気味・停滞のどれでもなければ null (判定できず)。
 * 受入条件は番号で対応させ、 判定が触れなかった条件は「危うい」、 根拠は実在するキーだけ、
 * 実在の根拠が無い「到達」は「見込みあり」にする。
 */
export function normalizeJudgment(raw: RawJudgment | null, acceptance: readonly string[], evidence: EvidenceSnapshot): ProgressJudgment | null {
  if (!raw || typeof raw !== "object" || !isVerdict(raw.verdict)) return null;
  const known = new Set(evidence.items.map((item) => item.key));
  const byIndex = new Map<number, { outlook: AcceptanceOutlook; refs: string[] }>();
  for (const entry of Array.isArray(raw.acceptance) ? raw.acceptance : []) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { index?: unknown; outlook?: unknown; refs?: unknown };
    const index = typeof e.index === "number" && Number.isInteger(e.index) ? e.index - 1 : -1;
    if (index < 0 || index >= acceptance.length || byIndex.has(index)) continue;
    const refs = Array.isArray(e.refs) ? [...new Set(e.refs.filter((ref): ref is string => typeof ref === "string" && known.has(ref)))] : [];
    byIndex.set(index, { outlook: isOutlook(e.outlook) ? e.outlook : "at_risk", refs });
  }
  const reason = typeof raw.reason === "string" ? raw.reason.replace(/\s+/g, " ").trim().slice(0, REASON_LIMIT) : "";
  return {
    verdict: raw.verdict,
    reason: reason || "(理由なし)",
    acceptance: acceptance.map((item, index) => {
      const judged = byIndex.get(index) ?? { outlook: "at_risk" as const, refs: [] };
      const outlook = judged.outlook === "reached" && judged.refs.length === 0 ? "likely" : judged.outlook;
      return { item, outlook, refs: judged.refs };
    }),
  };
}
// @ts-expect-error augur-inject
normalizeJudgment = contract(normalizeJudgment, { ...augurContract_8c1aa290, contractId: 'dg-C-12', mode: 'observe', sample: 1, where: 'src/daily-goal-run/judgment-policy.ts:46', rule: 'contract-wrap', id: '8c1aa290' }); /* augur-inject:contract-wrap:8c1aa290 */

/** 判定が「到達」とし、 実在の根拠がある受入条件だけで到達を照合する。 */
export function reachedByJudgment(goal: Pick<DailyGoal, "acceptance">, judgment: ProgressJudgment): { reached: boolean; progress: Record<string, string[]> } {
  const progress: Record<string, string[]> = {};
  for (const entry of judgment.acceptance) progress[entry.item] = entry.outlook === "reached" ? entry.refs : [];
  const result = evaluateGoalReached(goal.acceptance, new Map(Object.entries(progress)));
  return { reached: result.reached, progress };
}

/** 確認の期限が来ているか。 起点は前回の確認、 無ければ登録。 時刻で止める判断はしない。 */
export function isCheckpointDue(goal: DailyGoal, lastCheckpointAt: number | null, now: number, minutes: number): boolean {
  if (!isActiveGoal(goal)) return false;
  const base = lastCheckpointAt ?? goal.confirmedAt;
  return now - base >= Math.max(1, minutes) * 60_000;
}
