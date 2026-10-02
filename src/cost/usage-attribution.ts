/**
 * セッションの消費を「指示を出した人ごと」に予算の帰属先へ分ける (spec/feature/usage-budgets.md §3.2、
 * 2026-10-02 neco 指示「他のユーザーが助けに入った場合はそのユーザーの予算を使います」)。
 *
 * - セッションに人 (Discord の利用者) が指示を出した時刻から、 次に別の人が指示を出すまでの消費は、 その指示を出した人に付ける。
 * - 起動者の指示ぶんと、 指示がまだ無い区間は従来どおり起動時の帰属先 (チーム → 起動者)。
 * - 起動者以外の人の指示ぶんはその人のユーザー予算。 起動者が分からないセッションは助けに入った人を区別できないので、
 *   全区間を起動時の帰属先に付ける (導入で既存の数え方を変えない)。
 * - 倍率を掛ける「消費する人」は、 その区間の指示を出した人 (指示が無ければ起動者)。
 *
 * 純関数のみ。 ログ・DB の読み出しは呼び出し側。
 *
 * @implements SPEC-USAGE-BUDGET-POLICY
 */

import type { SessionEventRow } from "../shared/types.js";
import { parseRequesterSource } from "../control/requester.js";
import { subjectForSession, type BudgetSubject } from "./usage-budget.js";
import type { UsagePoint } from "./usage-timeline.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:9d565b34 */
import augurContract_380d199c from './usage-attribution.contract.js'; /* augur-inject:contract-predicate:a959c032 */

const DISCORD_USER_ID = /^\d{5,32}$/;

/** 人の指示 1 件 (atMs = epoch ms)。 */
export interface InstructionMark {
  atMs: number;
  userId: string;
}

/** セッション 1 本の帰属の前提。 */
export interface SessionAttribution {
  /** 起動時の帰属先 (チーム → 起動者)。 無ければ起動者の区間は数えない。 */
  defaultSubject: BudgetSubject | null;
  /** 起動者 (Discord の利用者)。 分からなければ null。 */
  launcherUserId: string | null;
  /** 人の指示 (時刻の昇順)。 */
  instructions: readonly InstructionMark[];
}

/** その時点の消費を引き受ける帰属先と、 倍率を掛ける人。 */
export interface Responsibility {
  subject: BudgetSubject | null;
  personUserId: string | null;
}

/** 予算から引く単位 (同じ帰属先・同じ人の消費はまとめる)。 */
export interface UsageCharge {
  subject: BudgetSubject;
  personUserId: string | null;
  tokens: number;
}

/** inject イベント (新旧どちらの順でもよい) から、 Discord の人の指示を時刻の昇順で取り出す。 */
export function instructionMarks(events: readonly SessionEventRow[]): InstructionMark[] {
  const marks: InstructionMark[] = [];
  for (const event of events) {
    if (event.kind !== "inject") continue;
    let source: unknown;
    try {
      source = (JSON.parse(event.payload) as { source?: unknown }).source;
    } catch {
      continue;
    }
    const requester = parseRequesterSource(source);
    if (requester?.platform !== "discord" || !DISCORD_USER_ID.test(requester.userId)) continue;
    marks.push({ atMs: event.ts * 1000, userId: requester.userId });
  }
  return marks.sort((a, b) => a.atMs - b.atMs);
}

/** 起動済みセッションの帰属の前提を組み立てる。 */
export function sessionAttribution(
  session: { team_id?: string | null; metadata: string | null },
  events: readonly SessionEventRow[],
): SessionAttribution {
  const defaultSubject = subjectForSession(session);
  return {
    defaultSubject,
    launcherUserId: readLauncherUserId(session.metadata),
    instructions: instructionMarks(events),
  };
}

function readLauncherUserId(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const value = (JSON.parse(metadata) as { discord_requester_user_id?: unknown }).discord_requester_user_id;
    return typeof value === "string" && DISCORD_USER_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** atMs の時点の消費を引き受ける帰属先 (直前の人の指示で決まる)。 */
export function responsibleAt(attribution: SessionAttribution, atMs: number): Responsibility {
  let latest: InstructionMark | null = null;
  for (const mark of attribution.instructions) {
    if (mark.atMs > atMs) break;
    latest = mark;
  }
  const launcher = attribution.launcherUserId;
  if (!latest) return { subject: attribution.defaultSubject, personUserId: launcher };
  if (launcher === null || latest.userId === launcher) {
    return { subject: attribution.defaultSubject, personUserId: latest.userId };
  }
  return { subject: { scope: "user", targetId: latest.userId }, personUserId: latest.userId };
}

/** 時刻つきの消費を帰属先と人ごとに分ける。 帰属先の無い区間は数えない。 */
export function attributeUsage(attribution: SessionAttribution, points: readonly UsagePoint[]): UsageCharge[] {
  const charges = new Map<string, UsageCharge>();
  for (const point of points) {
    if (!(point.tokens > 0)) continue;
    const { subject, personUserId } = responsibleAt(attribution, point.atMs);
    if (!subject) continue;
    const key = `${subject.scope}:${subject.targetId}\u0000${personUserId ?? ""}`;
    const current = charges.get(key);
    if (current) current.tokens += point.tokens;
    else charges.set(key, { subject, personUserId, tokens: point.tokens });
  }
  return [...charges.values()];
}
// @ts-expect-error augur-inject
attributeUsage = contract(attributeUsage, { ...augurContract_380d199c, contractId: 'budget-C-2', mode: 'observe', sample: 1, where: 'src/cost/usage-attribution.ts:109', rule: 'contract-wrap', id: '380d199c' }); /* augur-inject:contract-wrap:380d199c */

/** 時刻の取れないセッションは、 合計を起動時の帰属先 (と起動者の倍率) にまとめて付ける。 */
export function attributeTotal(attribution: SessionAttribution, total: number): UsageCharge[] {
  if (!attribution.defaultSubject || !(total > 0)) return [];
  return [{ subject: attribution.defaultSubject, personUserId: attribution.launcherUserId, tokens: total }];
}
