/**
 * セッションの消費を「指示を出した人ごと」に予算の帰属先へ分ける (spec/feature/usage-budgets.md §3.2、
 * 2026-10-02 neco 指示「他のユーザーが助けに入った場合はそのユーザーの予算を使います」、 2026-10-03「指示した人数で割る」
 * 「指示の回数で重みつけます」)。
 *
 * - 消費を AI の応答 1 回ごと (前の最終回答の直後から次の最終回答まで) の区間に切り (instruction-split.ts)、
 *   区間の消費をその区間に各人が出した指示の回数で按分する。 1 人なら全額。
 * - 起動者の指示ぶんと、 指示が無い区間は従来どおり起動時の帰属先 (チーム → 起動者)。
 * - 起動者以外の人の指示ぶんはその人のユーザー予算。 起動者が分からないセッションは助けに入った人を区別できないので、
 *   全区間を起動時の帰属先に付ける (導入で既存の数え方を変えない)。
 * - 倍率を掛ける「消費する人」は、 按分した各人 (指示が無い区間は起動者)。 倍率は按分した額に人ごとに掛ける。
 *
 * 純関数のみ。 ログ・DB の読み出しは呼び出し側。
 *
 * @implements SPEC-USAGE-BUDGET-POLICY
 */

import type { SessionEventRow } from "../shared/types.js";
import { parseRequesterSource } from "../control/requester.js";
import { subjectForSession, type BudgetSubject } from "./usage-budget.js";
import type { UsagePoint } from "./usage-timeline.js";
import { splitByInstructionCount, turnSegments, type InstructionMark } from "./instruction-split.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:9d565b34 */
import augurContract_380d199c from './usage-attribution.contract.js'; /* augur-inject:contract-predicate:a959c032 */

const DISCORD_USER_ID = /^\d{5,32}$/;

export type { InstructionMark };

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

/** 指示を出した人の消費を引き受ける帰属先。 起動者 (または起動者不明) は起動時の帰属先、 それ以外はその人のユーザー予算。 */
function responsibilityOf(attribution: SessionAttribution, userId: string): Responsibility {
  const launcher = attribution.launcherUserId;
  if (launcher === null || userId === launcher) return { subject: attribution.defaultSubject, personUserId: userId };
  return { subject: { scope: "user", targetId: userId }, personUserId: userId };
}

/**
 * atMs の時点の消費を引き受ける帰属先 (直前の人の指示で決まる)。 作業中の判定 (§5.2、 ハーネスの gate) が使う。
 * 予算の集計は区間ごとの按分 (attributeUsage) で行う。
 */
export function responsibleAt(attribution: SessionAttribution, atMs: number): Responsibility {
  let latest: InstructionMark | null = null;
  for (const mark of attribution.instructions) {
    if (mark.atMs > atMs) break;
    latest = mark;
  }
  if (!latest) return { subject: attribution.defaultSubject, personUserId: attribution.launcherUserId };
  return responsibilityOf(attribution, latest.userId);
}

/** 時刻つきの消費を AI の応答ごとの区間に切り、 指示の回数で按分して帰属先と人ごとに分ける。 帰属先の無い区間は数えない。 */
export function attributeUsage(attribution: SessionAttribution, points: readonly UsagePoint[]): UsageCharge[] {
  const charges = new Map<string, UsageCharge>();
  const add = ({ subject, personUserId }: Responsibility, tokens: number) => {
    if (!subject || !(tokens > 0)) return;
    const key = `${subject.scope}:${subject.targetId}\u0000${personUserId ?? ""}`;
    const current = charges.get(key);
    if (current) current.tokens += tokens;
    else charges.set(key, { subject, personUserId, tokens });
  };
  for (const segment of turnSegments(points, attribution.instructions)) {
    if (!(segment.tokens > 0)) continue;
    if (segment.instructedBy.length === 0) {
      add({ subject: attribution.defaultSubject, personUserId: attribution.launcherUserId }, segment.tokens);
      continue;
    }
    for (const share of splitByInstructionCount(segment.tokens, segment.instructedBy)) {
      add(responsibilityOf(attribution, share.userId), share.tokens);
    }
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
