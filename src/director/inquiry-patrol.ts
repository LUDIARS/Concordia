/**
 * @implements spec/feature/director-inquiry-session.md §1 §4
 *
 * Director 問診セッションの計画 (純関数)。
 *
 * patrol.ts が「人間へ上げる」と決めた事由 (escalate) と、本 spec で新設する停滞事由を
 * 受け、そのうち **どれを問診セッションの起動へ格上げするか** を決める。LLM は呼ばない。
 * invoke / カード投稿 / repo 更新といった副作用は patrol-runtime 側が持つ。
 *
 * 問診は「問いを作らせる」ためだけの起動なので、起動しない判断 (ガード) の方が本体である。
 * ガードを一箇所に集め、runtime からは結果だけを見えるようにする。
 */

import type { PatrolEscalationReason } from "./patrol.js";

/** 停滞判定の既定閾値 (spec §1: N=4 tick ≒ 2 時間)。 */
export const DEFAULT_STALL_TICKS = 4;

/** 1 case あたり同一 UTC 日に起動できる問診 run の上限 (spec §4)。 */
export const DEFAULT_MAX_INQUIRIES_PER_CASE_PER_DAY = 3;

/** 1 tick あたりの問診起動数の上限 (spec §4。実装セッションの枠とは別枠)。 */
export const DEFAULT_MAX_INQUIRY_LAUNCHES_PER_TICK = 1;

/**
 * 問診の起動事由。patrol の escalate 事由をそのまま格上げしたものに、本 spec で
 * 新設する `stalled` を足したもの。
 */
export type InquiryReason = PatrolEscalationReason | "stalled";

export interface InquiryLimits {
  stallTicks: number;
  maxInquiriesPerCasePerDay: number;
  maxLaunchesPerTick: number;
}

export const DEFAULT_INQUIRY_LIMITS: InquiryLimits = {
  stallTicks: DEFAULT_STALL_TICKS,
  maxInquiriesPerCasePerDay: DEFAULT_MAX_INQUIRIES_PER_CASE_PER_DAY,
  maxLaunchesPerTick: DEFAULT_MAX_INQUIRY_LAUNCHES_PER_TICK,
};

/** 問診の起動候補 1 件。patrol の escalate から格上げされた、または停滞で新設された。 */
export interface InquiryCandidate {
  caseId: string;
  reason: InquiryReason;
  /** 事由の対象 step。停滞など step を特定できない事由では null。 */
  stepId: string | null;
  /** 機械文カードへフォールバックするときに使う本文 (patrol §1.4 と同じもの)。 */
  detail: string;
}

/**
 * 起動を止めた理由。runtime はこれを見て「機械文カードだけ出す」へ倒す。
 * 候補が消えるのではなく、`launch: false` として理由付きで残るのが要点で、
 * 「問診は出さなかったが人間への通知は落ちていない」ことを呼び出し側で保証できる。
 */
export type InquirySkipReason =
  | "already-launched"
  | "unanswered-decision"
  | "daily-quota"
  | "tick-quota";

export interface InquiryDecisionResult {
  candidate: InquiryCandidate;
  /** true なら問診セッションを起動する。false なら機械文カードのみ。 */
  launch: boolean;
  skipReason?: InquirySkipReason;
}

export interface PlanInquiriesInput {
  candidates: readonly InquiryCandidate[];
  /** 同じ日次冪等キーの run が既にあるか。既存 run は起動枠もカードも消費しない。 */
  hasExistingInquiry: (candidate: InquiryCandidate) => boolean;
  /** 当該 case に未回答の問診 decision が残っているか (spec §4)。 */
  hasUnansweredDecision: (caseId: string) => boolean;
  /** 当該 case について、指定 UTC 日に開始した問診 run の件数 (永続記録から数える)。 */
  countInquiriesToday: (caseId: string) => number;
  limits?: Partial<InquiryLimits>;
}

/**
 * 起動候補にガードを適用して、起動するもの / 機械文へ倒すものへ振り分ける。
 *
 * 候補は入力順に評価する。patrol の escalate は「反映 → 起動 → エスカレーション」の
 * 順で積まれるので、古い case の事由が先に問診枠を取る。
 */
export function planInquiries(input: PlanInquiriesInput): InquiryDecisionResult[] {
  const limits: InquiryLimits = { ...DEFAULT_INQUIRY_LIMITS, ...input.limits };
  const results: InquiryDecisionResult[] = [];
  // 同一 tick 内で同じ case を複数回起動しないための、日次カウントの加算分。
  const launchedPerCase = new Map<string, number>();
  let launched = 0;

  for (const candidate of input.candidates) {
    // 冪等済みの候補を先に除外する。tick quota の後で判定すると、先頭の既存候補が
    // 毎巡枠を消費し、後続の新規候補が永続的に起動できなくなる。
    if (input.hasExistingInquiry(candidate)) {
      results.push({ candidate, launch: false, skipReason: "already-launched" });
      continue;
    }
    // 未回答の問いが残っている case へ問いを重ねない。人間の応答待ちを増やすだけで、
    // 質問カードの信号を薄める。
    if (input.hasUnansweredDecision(candidate.caseId)) {
      results.push({ candidate, launch: false, skipReason: "unanswered-decision" });
      continue;
    }
    const already = input.countInquiriesToday(candidate.caseId)
      + (launchedPerCase.get(candidate.caseId) ?? 0);
    if (already >= limits.maxInquiriesPerCasePerDay) {
      results.push({ candidate, launch: false, skipReason: "daily-quota" });
      continue;
    }
    if (launched >= limits.maxLaunchesPerTick) {
      results.push({ candidate, launch: false, skipReason: "tick-quota" });
      continue;
    }
    launched += 1;
    launchedPerCase.set(candidate.caseId, (launchedPerCase.get(candidate.caseId) ?? 0) + 1);
    results.push({ candidate, launch: true });
  }
  return results;
}

/**
 * 問診起動の冪等キー (spec §2)。UTC 日付を含めるので、同一 case × 同一事由は
 * 日単位で 1 件に収束する。プロセス内状態に依存しない。
 *
 * 停滞のように対象 step が無い事由では case id を使う。
 */
export function inquiryTriggeredBy(input: {
  stepId: string | null;
  caseId: string;
  reason: InquiryReason;
  now: number;
}): string {
  const subject = input.stepId ?? input.caseId;
  const day = new Date(input.now).toISOString().slice(0, 10);
  return `director-inquiry:${subject}:${input.reason}:${day}`;
}

/** LIKE パターンへ埋め込む値の escape (`\` を escape 文字として使う)。 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * 「この case について、指定 UTC 日に開始した問診 run」を数えるための LIKE パターン群。
 *
 * 冪等キーの subject は step id か case id なので (spec §2)、case に属する全 step と
 * case 自身を subject 候補として並べる。reason 部分だけをワイルドカードにするので、
 * 事由をまたいだ日次上限 (spec §4) を 1 クエリで数えられる。
 */
export function inquiryDailyCountPatterns(input: {
  caseId: string;
  stepIds: readonly string[];
  now: number;
}): string[] {
  const day = new Date(input.now).toISOString().slice(0, 10);
  const subjects = [input.caseId, ...input.stepIds];
  return [...new Set(subjects)].map(
    (subject) => `director-inquiry:${escapeLikePattern(subject)}:%:${day}`,
  );
}

export interface StallInput {
  /** 当該 case が未完了 (完了/取り下げでない step が残る) か。 */
  hasOpenWork: boolean;
  /** 当該 tick で実行可能な step があったか (patrol の nextExecutableStep 相当)。 */
  hasExecutableStep: boolean;
  /** 当該 case で実行中の step があるか。動いているなら停滞ではない。 */
  hasActiveStep: boolean;
  /** 永続化された連続停滞 tick 数 (再起動をまたいで数える)。 */
  stallTicks: number;
  limits?: Partial<Pick<InquiryLimits, "stallTicks">>;
}

export type StallVerdict =
  /** 前進があったのでカウンタを 0 に戻す。 */
  | { type: "reset" }
  /** 停滞が続いているのでカウンタを進める。閾値未満なので問診はまだ出さない。 */
  | { type: "bump"; ticks: number }
  /** 閾値に達した。問診の起動事由になる。 */
  | { type: "stalled"; ticks: number };

/**
 * 停滞判定 (spec §1 の新設事由)。
 *
 * 「実行可能 step が無い」だけでは停滞にしない。実行中の step がある case は
 * 委託が走っているだけなので、閾値を数え始めると走行中の case にまで問いが出る。
 */
export function judgeStall(input: StallInput): StallVerdict {
  const threshold = input.limits?.stallTicks ?? DEFAULT_STALL_TICKS;
  if (!input.hasOpenWork || input.hasExecutableStep || input.hasActiveStep) {
    return { type: "reset" };
  }
  const ticks = input.stallTicks + 1;
  return ticks >= threshold ? { type: "stalled", ticks } : { type: "bump", ticks };
}
