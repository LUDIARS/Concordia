/**
 * ローカルセッションのハーネス強制ゲート (決定的判定の集約)。
 *
 * 子会社 gate.ts (出張先依頼 → Sonnet guard → delegation 起動) の "ローカル版"。
 * 違いは: 対象が自セッションの操作で、 allow なら spawn でなく「操作をそのまま通す」、
 * deny なら hook が操作をブロックする。 判定は決定的 (predicates.ts)。
 *
 * 本モジュールは純関数 (DB 非依存)。 監査記録・HTTP は api/harness-session.ts が担う (SRP)。
 */

import { DEFAULT_PREDICATES, type Decision, type HarnessAction, type Predicate, type PredicateHit } from "./predicates.js";

export interface GateVerdict {
  /** 当たった hit の最悪 decision。 hit が無ければ allow。 */
  decision: Decision;
  hits: PredicateHit[];
  /** deny を含むか (hook が操作をブロックすべきか)。 */
  blocked: boolean;
  /** 人間/AI 向けの 1 行サマリ。 */
  reason: string;
}

const SEVERITY: Record<Decision, number> = { allow: 0, warn: 1, deny: 2 };

/** 述語群を action に適用し、 最悪 decision を集約する。 決定的・副作用なし。 */
export function evaluateAction(action: HarnessAction, predicates: Predicate[] = DEFAULT_PREDICATES): GateVerdict {
  const hits: PredicateHit[] = [];
  for (const p of predicates) {
    const hit = p(action);
    if (hit) hits.push(hit);
  }

  let worst: Decision = "allow";
  for (const h of hits) {
    if (SEVERITY[h.decision] > SEVERITY[worst]) worst = h.decision;
  }

  const reason =
    hits.length === 0
      ? "ハーネス違反なし"
      : hits.map((h) => `[${h.rule}] ${h.reason}${h.suggestion ? ` → ${h.suggestion}` : ""}`).join(" / ");

  return { decision: worst, hits, blocked: worst === "deny", reason };
}
