/**
 * バグバウンティ企画の判断 (spec/feature/bug-bounty.md §0 §8.2 §18)。 純関数。
 *
 * 企画は「報告の受付条件」ではなく、期間・対象プロジェクト・受付口・案内文・報奨の上書きを持つ催し
 * (2026-10-04 訂正「報告は常時できる」を維持)。 開催中の企画に当たる報告だけを受付時に企画へ紐付ける。
 *
 * @implements SPEC-BOUNTY-EVENT
 * @implements SPEC-BOUNTY-REWARD
 */

import type { BountySeverity } from "../db/bounty-reports-repo.js";
import { BOUNTY_INTAKE_PLATFORMS, type BountyIntakePlatform } from "./intake.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:cb9ebb77 */
import augurContract_e4d0e09b from './event-match.contract.js'; /* augur-inject:contract-predicate:1185b9d5 */
import augurContract_ffb59e76 from './event-draft.contract.js'; /* augur-inject:contract-predicate:4d3d4a09 */
import augurContract_5f996d38 from './event-reward.contract.js'; /* augur-inject:contract-predicate:1c966cb4 */

/** 企画の対象にできる受付口。 受付の platform と同じ値。 */
export type BountyEventChannel = BountyIntakePlatform;
export const BOUNTY_EVENT_CHANNELS: readonly BountyEventChannel[] = BOUNTY_INTAKE_PLATFORMS;

const SEVERITIES: readonly BountySeverity[] = ["s1", "s2", "s3", "s4"];

/** 深刻度ごとの報奨の加算量の上書き。 無い深刻度は個人の AI 予算の既定値を使う。 */
export type BountyRewardOverride = Partial<Record<BountySeverity, number>>;

export interface BountyEvent {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  /** 対象プロジェクトのコード (project registry の表記のまま)。 */
  projects: readonly string[];
  channels: readonly BountyEventChannel[];
  guidance: string;
  rewardOverride: BountyRewardOverride | null;
  /** 早期終了した時刻。 終了を前倒しする。 */
  endedEarlyAt: number | null;
}

export type BountyEventPhase = "scheduled" | "open" | "ended";

export const MAX_BOUNTY_EVENT_TITLE_CHARS = 100;
export const MAX_BOUNTY_EVENT_GUIDANCE_CHARS = 1000;
export const MAX_BOUNTY_EVENT_PROJECTS = 50;
/** 個人の AI 予算の 1 件の上限 (personal-budget の MAX_TOKENS_PER_ENTRY) と同じ。 予算側でも頭打ちにする。 */
export const MAX_BOUNTY_EVENT_REWARD_TOKENS = 1_000_000_000;

/** 早期終了を考えた実際の終了時刻。 */
export function bountyEventEnd(event: Pick<BountyEvent, "endsAt" | "endedEarlyAt">): number {
  return event.endedEarlyAt === null ? event.endsAt : Math.min(event.endsAt, event.endedEarlyAt);
}

export function bountyEventPhase(event: Pick<BountyEvent, "startsAt" | "endsAt" | "endedEarlyAt">, now: number): BountyEventPhase {
  if (now >= bountyEventEnd(event)) return "ended";
  return now < event.startsAt ? "scheduled" : "open";
}

export interface BountyEventMatchInput {
  events: readonly BountyEvent[];
  /** 受付時に決まった対象プロジェクトのコード。 不明なら null。 */
  project: string | null;
  platform: BountyEventChannel;
  /** 受付口が選んだ企画。 無ければ null。 */
  eventId: string | null;
  now: number;
}

export type BountyEventMatch =
  | { ok: true; event: BountyEvent | null }
  | { ok: false; error: "event_not_applicable" };

/**
 * 報告を紐付ける企画を決める (CC-BOUNTY-INV-11)。 候補は「開催中」「対象プロジェクトにコードが完全一致で含まれる」
 * 「受付口が含まれる」企画。 指定が無ければ終了の早い順 → 開始の早い順 → id 順の先頭。 候補が無ければ企画なしで、
 * 受付そのものは続ける (企画は受付条件ではない)。 指定した企画が候補に無いときだけ拒む。
 */
export function matchBountyEvent(input: BountyEventMatchInput): BountyEventMatch {
  const project = input.project;
  const candidates = project === null ? [] : input.events
    .filter((event) => bountyEventPhase(event, input.now) === "open"
      && event.projects.includes(project)
      && event.channels.includes(input.platform))
    .sort((left, right) => bountyEventEnd(left) - bountyEventEnd(right)
      || left.startsAt - right.startsAt
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (input.eventId) {
    const chosen = candidates.find((event) => event.id === input.eventId);
    return chosen ? { ok: true, event: chosen } : { ok: false, error: "event_not_applicable" };
  }
  return { ok: true, event: candidates[0] ?? null };
}
// @ts-expect-error augur-inject
matchBountyEvent = contract(matchBountyEvent, { ...augurContract_e4d0e09b, contractId: 'bounty-event-C-1', mode: 'observe', sample: 1, where: 'src/bounty/event-policy.ts:74', rule: 'contract-wrap', id: 'e4d0e09b' }); /* augur-inject:contract-wrap:e4d0e09b */

/** 作成・編集の入力。 編集は渡した項目だけを変える。 */
export interface BountyEventDraft {
  title?: string;
  startsAt?: number;
  endsAt?: number;
  projects?: readonly string[];
  channels?: readonly string[];
  guidance?: string;
  rewardOverride?: Readonly<Record<string, number>> | null;
}

export interface BountyEventDraftInput {
  draft: BountyEventDraft;
  /** 編集なら今の企画。 作成なら null。 */
  current: BountyEvent | null;
  /** project registry に登録済みのコード。 */
  registeredCodes: readonly string[];
  now: number;
}

export type BountyEventDraftError =
  | "title_invalid"
  | "guidance_invalid"
  | "period_invalid"
  | "projects_invalid"
  | "unknown_project"
  | "channels_invalid"
  | "reward_override_invalid"
  | "event_projects_reduced"
  | "event_started"
  | "event_ended";

export type BountyEventFields = Omit<BountyEvent, "id" | "endedEarlyAt">;

export type BountyEventDraftResult =
  | { ok: true; value: BountyEventFields }
  | { ok: false; error: BountyEventDraftError };

/** 起動案内の 1 行に載るので、 改行とバッククォートは受けない。 */
const ONE_LINE = /^[^\r\n`]*$/;

/**
 * 企画の作成・編集を検証し、 保存する値を返す。 開始済みの企画は対象プロジェクトを減らせず開始時刻も変えられない
 * (受付済みの報告と食い違うため)。 終了した企画は変えられない。
 */
export function validateBountyEventDraft(input: BountyEventDraftInput): BountyEventDraftResult {
  const { draft, current, now } = input;
  if (current && bountyEventPhase(current, now) === "ended") return { ok: false, error: "event_ended" };
  const title = (draft.title ?? current?.title ?? "").trim();
  if (!title || title.length > MAX_BOUNTY_EVENT_TITLE_CHARS || !ONE_LINE.test(title)) return { ok: false, error: "title_invalid" };
  const guidance = (draft.guidance ?? current?.guidance ?? "").trim();
  if (guidance.length > MAX_BOUNTY_EVENT_GUIDANCE_CHARS || !ONE_LINE.test(guidance)) return { ok: false, error: "guidance_invalid" };
  const startsAt = draft.startsAt ?? current?.startsAt;
  const endsAt = draft.endsAt ?? current?.endsAt;
  if (!isTime(startsAt) || !isTime(endsAt) || startsAt >= endsAt) return { ok: false, error: "period_invalid" };
  const projects = unique((draft.projects ?? current?.projects ?? []).map((code) => code.trim()).filter(Boolean));
  if (projects.length === 0 || projects.length > MAX_BOUNTY_EVENT_PROJECTS) return { ok: false, error: "projects_invalid" };
  const registered = new Set(input.registeredCodes);
  if (!projects.every((code) => registered.has(code))) return { ok: false, error: "unknown_project" };
  const channelInput = draft.channels ?? current?.channels ?? [];
  if (!channelInput.every((channel) => (BOUNTY_EVENT_CHANNELS as readonly string[]).includes(channel))) {
    return { ok: false, error: "channels_invalid" };
  }
  const channels = BOUNTY_EVENT_CHANNELS.filter((channel) => channelInput.includes(channel));
  if (channels.length === 0) return { ok: false, error: "channels_invalid" };
  const override = draft.rewardOverride === undefined ? current?.rewardOverride ?? null : normalizeOverride(draft.rewardOverride);
  if (override === "invalid") return { ok: false, error: "reward_override_invalid" };
  if (current && current.startsAt <= now) {
    if (startsAt !== current.startsAt) return { ok: false, error: "event_started" };
    if (!current.projects.every((code) => projects.includes(code))) return { ok: false, error: "event_projects_reduced" };
  }
  return { ok: true, value: { title, startsAt, endsAt, projects, channels, guidance, rewardOverride: override } };
}
// @ts-expect-error augur-inject
validateBountyEventDraft = contract(validateBountyEventDraft, { ...augurContract_ffb59e76, contractId: 'bounty-event-C-2', mode: 'observe', sample: 1, where: 'src/bounty/event-policy.ts:135', rule: 'contract-wrap', id: 'ffb59e76' }); /* augur-inject:contract-wrap:ffb59e76 */

/** 報告の深刻度に対する企画の報奨の上書き。 無ければ null (個人の AI 予算の既定値を使う)。 */
export function bountyEventRewardOverride(
  event: Pick<BountyEvent, "rewardOverride"> | null,
  severity: BountySeverity | null,
): number | null {
  if (!event?.rewardOverride || !severity) return null;
  return event.rewardOverride[severity] ?? null;
}
// @ts-expect-error augur-inject
bountyEventRewardOverride = contract(bountyEventRewardOverride, { ...augurContract_5f996d38, contractId: 'bounty-event-C-3', mode: 'observe', sample: 1, where: 'src/bounty/event-policy.ts:165', rule: 'contract-wrap', id: '5f996d38' }); /* augur-inject:contract-wrap:5f996d38 */

function normalizeOverride(raw: Readonly<Record<string, number>> | null): BountyRewardOverride | null | "invalid" {
  if (raw === null) return null;
  const result: BountyRewardOverride = {};
  for (const [key, tokens] of Object.entries(raw)) {
    if (!(SEVERITIES as readonly string[]).includes(key)) return "invalid";
    if (!Number.isInteger(tokens) || tokens < 0 || tokens > MAX_BOUNTY_EVENT_REWARD_TOKENS) return "invalid";
    result[key as BountySeverity] = tokens;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function isTime(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
