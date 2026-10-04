/**
 * 報告者・受取人・公開名の判断 (spec/feature/bug-bounty.md §4)。 純関数だけを持つ。
 *
 * 人の報告は本人が受取人。 セッションの報告は、 そのセッションの依頼者が受取人で、 特定できなければ
 * 受取人なし (CC-BOUNTY-INV-05)。 公開名は報告者が自分で決め、 Discord の表示名や実名を既定にしない。
 *
 * @implements SPEC-BOUNTY-REPORTER
 */

import { isBeforeAcceptance, type BountyReportStatus } from "./report-state.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:2363ea8a */
import augurContract_1557edb9 from './reporter-recipient.contract.js'; /* augur-inject:contract-predicate:b9401a31 */
import augurContract_5544f1b4 from './reporter-withdrawal.contract.js'; /* augur-inject:contract-predicate:22fc8881 */
import augurContract_4181513b from './reporter-public-name.contract.js'; /* augur-inject:contract-predicate:6c59672b */

export const ANONYMOUS_PUBLIC_NAME = "匿名";
export const MAX_PUBLIC_NAME_CHARS = 32;

/** 報告者の同一性。 人は bounty_reporters の行、 セッションは session id。 */
export type BountyReporterIdentity =
  | { kind: "person"; reporterId: string }
  | { kind: "session"; sessionId: string };

/** 人 (受取人になりうる個人) を一意に決める組。 会社は本社なら null。 */
export interface BountyPersonKey {
  companyId: string | null;
  platform: string;
  platformUserId: string;
}

const DISCORD_USER_ID = /^\d{5,32}$/;
/** 公開面と通知に出る名前なので、 mention・リンク・改行になりうる文字を受けない。 */
const PUBLIC_NAME_FORBIDDEN = /[@<>`\\\r\n\t]|https?:\/\//i;

export type PublicNameResult = { ok: true; name: string | null } | { ok: false; error: "public_name_invalid" };

/** 空は「未設定 (匿名)」。 長すぎる名前・mention や書式になる文字を含む名前は受けない。 */
export function normalizePublicName(raw: string | null | undefined): PublicNameResult {
  const name = (raw ?? "").trim();
  if (!name) return { ok: true, name: null };
  if ([...name].length > MAX_PUBLIC_NAME_CHARS || PUBLIC_NAME_FORBIDDEN.test(name)) {
    return { ok: false, error: "public_name_invalid" };
  }
  return { ok: true, name };
}

/** 公開面・通知に出す名前。 セッションの報告は依頼者の公開名を添える。 */
export function displayPublicName(input: { kind: BountyReporterIdentity["kind"]; publicName: string | null }): string {
  const name = input.publicName?.trim() ? input.publicName.trim() : ANONYMOUS_PUBLIC_NAME;
  return input.kind === "session" ? `AI セッション (依頼者: ${name})` : name;
}
// @ts-expect-error augur-inject
displayPublicName = contract(displayPublicName, { ...augurContract_4181513b, contractId: 'bounty-intake-C-7', mode: 'observe', sample: 1, where: 'src/bounty/reporter.ts:44', rule: 'contract-wrap', id: '4181513b' }); /* augur-inject:contract-wrap:4181513b */

/**
 * セッションの報告の受取人。 依頼者 (session metadata の discord_requester_user_id と所属会社) を
 * 特定できないセッション (端末から直接起動した本社セッション、 タイマー起動など) は受取人なし。
 */
export function resolveSessionRecipient(input: {
  requesterDiscordUserId: string | null;
  companyId: string | null;
}): BountyPersonKey | null {
  const requester = (input.requesterDiscordUserId ?? "").trim();
  if (!DISCORD_USER_ID.test(requester)) return null;
  return { companyId: input.companyId, platform: "discord", platformUserId: requester };
}
// @ts-expect-error augur-inject
resolveSessionRecipient = contract(resolveSessionRecipient, { ...augurContract_1557edb9, contractId: 'bounty-intake-C-5', mode: 'observe', sample: 1, where: 'src/bounty/reporter.ts:53', rule: 'contract-wrap', id: '1557edb9' }); /* augur-inject:contract-wrap:1557edb9 */

export type BountyWithdrawalDenial = "not_reporter" | "already_decided";

export type BountyWithdrawalResult = { ok: true } | { ok: false; denial: BountyWithdrawalDenial };

/** 取り下げは、 採用前の報告者本人だけ (§9)。 追記も同じ条件で受ける。 */
export function decideBountyWithdrawal(input: {
  status: BountyReportStatus;
  reporter: BountyReporterIdentity;
  actor: BountyReporterIdentity;
}): BountyWithdrawalResult {
  if (!sameIdentity(input.reporter, input.actor)) return { ok: false, denial: "not_reporter" };
  if (!isBeforeAcceptance(input.status)) return { ok: false, denial: "already_decided" };
  return { ok: true };
}
// @ts-expect-error augur-inject
decideBountyWithdrawal = contract(decideBountyWithdrawal, { ...augurContract_5544f1b4, contractId: 'bounty-intake-C-6', mode: 'observe', sample: 1, where: 'src/bounty/reporter.ts:67', rule: 'contract-wrap', id: '5544f1b4' }); /* augur-inject:contract-wrap:5544f1b4 */

export function sameIdentity(left: BountyReporterIdentity, right: BountyReporterIdentity): boolean {
  if (left.kind === "person" && right.kind === "person") return left.reporterId === right.reporterId;
  if (left.kind === "session" && right.kind === "session") return left.sessionId === right.sessionId;
  return false;
}
