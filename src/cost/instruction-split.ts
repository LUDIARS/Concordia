/**
 * セッションの消費を「AI の応答 1 回ごとの区間」に切り、 区間の消費をその区間に指示を出した人で分ける
 * (spec/feature/usage-budgets.md §3.2、 2026-10-03 neco 指示「指示した人数で割る」「指示の回数で重みつけます」)。
 *
 * - 区間: 前の AI の最終回答 (turnEnd の点) の直後から、 次の AI の最終回答まで。 最後の最終回答より後は開いた区間。
 * - 区間の指示: その区間の時刻に入る人の指示 (最初の区間は最初の最終回答までのすべて)。
 * - 区間の消費は、 その区間で各人が出した指示の回数で按分する (A 2 回・B 1 回なら A に 2/3、 B に 1/3)。
 *
 * 純関数のみ。 帰属先 (チーム / 起動者 / 助けに入った人) の決め方は usage-attribution.ts。
 *
 * @implements SPEC-USAGE-BUDGET-POLICY
 */

import type { UsagePoint } from "./usage-timeline.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:e6e21aff */
import augurContract_49f22986 from './instruction-split.contract.js'; /* augur-inject:contract-predicate:ce332181 */

/** 人の指示 1 件 (atMs = epoch ms)。 */
export interface InstructionMark {
  atMs: number;
  userId: string;
}

/** AI の応答 1 回ぶんの区間。 */
export interface TurnSegment {
  tokens: number;
  /** その区間に指示を出した人 (指示 1 件につき 1 回、 時刻順)。 */
  instructedBy: string[];
}

/** 指示を出した人ごとの按分。 */
export interface InstructionShare {
  userId: string;
  tokens: number;
}

/** 時刻つきの消費と人の指示を、 AI の最終回答ごとの区間に切る。 消費の無い区間も返す。 */
export function turnSegments(points: readonly UsagePoint[], marks: readonly InstructionMark[]): TurnSegment[] {
  const sortedPoints = [...points].sort((a, b) => a.atMs - b.atMs);
  const sortedMarks = [...marks].sort((a, b) => a.atMs - b.atMs);
  const segments: TurnSegment[] = [];
  let current: TurnSegment = { tokens: 0, instructedBy: [] };
  let markIndex = 0;
  for (const point of sortedPoints) {
    if (point.tokens > 0) current.tokens += point.tokens;
    if (!point.turnEnd) continue;
    while (markIndex < sortedMarks.length && sortedMarks[markIndex].atMs <= point.atMs) {
      current.instructedBy.push(sortedMarks[markIndex].userId);
      markIndex += 1;
    }
    segments.push(current);
    current = { tokens: 0, instructedBy: [] };
  }
  // 最後の最終回答より後 (応答中・応答の印が無い) は開いた区間。 残りの指示をすべて入れる。
  for (; markIndex < sortedMarks.length; markIndex += 1) current.instructedBy.push(sortedMarks[markIndex].userId);
  if (current.tokens > 0 || current.instructedBy.length > 0) segments.push(current);
  return segments;
}

/** 区間の消費を、 指示を出した人ごとの指示の回数で按分する。 指示が無ければ空。 */
export function splitByInstructionCount(tokens: number, userIds: readonly string[]): InstructionShare[] {
  if (!(tokens > 0) || userIds.length === 0) return [];
  const counts = new Map<string, number>();
  for (const userId of userIds) counts.set(userId, (counts.get(userId) ?? 0) + 1);
  return [...counts].map(([userId, count]) => ({ userId, tokens: (tokens * count) / userIds.length }));
}
// @ts-expect-error augur-inject
splitByInstructionCount = contract(splitByInstructionCount, { ...augurContract_49f22986, contractId: 'budget-C-6', mode: 'observe', sample: 1, where: 'src/cost/instruction-split.ts:59', rule: 'contract-wrap', id: '49f22986' }); /* augur-inject:contract-wrap:49f22986 */
