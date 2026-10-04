/**
 * バグ報告の受付の判断 (spec/feature/bug-bounty.md §3)。 純関数だけを持つ。
 *
 * 入力の整形、 冪等キー、 受付時の状態を決める。 保存と権限の確認は intake-service.ts。
 * 報告の本文は冪等キーへ平文で入れない (鍵は索引とログに出るが、 原文は台帳だけに置く、 §10)。
 *
 * @implements SPEC-BOUNTY-INTAKE
 */

import { createHash } from "node:crypto";
import type { BountyReportStatus } from "./report-state.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:6b67fed1 */
import augurContract_1463dc51 from './intake-key.contract.js'; /* augur-inject:contract-predicate:e9ca56d2 */
import augurContract_f2c71bb8 from './intake-status.contract.js'; /* augur-inject:contract-predicate:226b87e7 */

export const BOUNTY_INTAKE_PLATFORMS = ["discord", "session", "cocoiru"] as const;
export type BountyIntakePlatform = (typeof BOUNTY_INTAKE_PLATFORMS)[number];

/** Discord のモーダル (Paragraph) の上限に合わせる。 どの受付口でも同じ長さで受ける。 */
export const MAX_BOUNTY_TEXT_CHARS = 4000;
export const MAX_BOUNTY_PROJECT_CODE_CHARS = 64;
export const MAX_BOUNTY_CLIENT_KEY_CHARS = 200;

export interface BountyIntakeFields {
  /** project registry のコード。 「どのプロジェクトか分からない」は null。 */
  project: string | null;
  what_happened: string;
  repro_steps: string;
}

export type BountyIntakeMissingField = "what_happened";

export function normalizeBountyIntake(raw: {
  project?: string | null;
  what_happened?: string | null;
  repro_steps?: string | null;
}): BountyIntakeFields {
  const project = (raw.project ?? "").trim();
  return {
    project: project ? project : null,
    what_happened: (raw.what_happened ?? "").trim(),
    repro_steps: (raw.repro_steps ?? "").trim(),
  };
}

/** 欠けている必須項目。 対象プロジェクトの未指定は「分からない」として受ける (仕分けが推定する)。 */
export function missingBountyIntakeFields(fields: Pick<BountyIntakeFields, "what_happened">): BountyIntakeMissingField[] {
  return fields.what_happened.trim() ? [] : ["what_happened"];
}

/** 受付時の状態。 必須項目が欠けていても受け付け、 情報不足として聞き返す。 */
export function initialBountyStatus(fields: Pick<BountyIntakeFields, "what_happened">): Extract<BountyReportStatus, "received" | "needs_info"> {
  return missingBountyIntakeFields(fields).length > 0 ? "needs_info" : "received";
}
// @ts-expect-error augur-inject
initialBountyStatus = contract(initialBountyStatus, { ...augurContract_f2c71bb8, contractId: 'bounty-intake-C-3', mode: 'observe', sample: 1, where: 'src/bounty/intake.ts:49', rule: 'contract-wrap', id: 'f2c71bb8' }); /* augur-inject:contract-wrap:f2c71bb8 */

/**
 * 冪等キー (CC-BOUNTY-INV-02)。 Discord は interaction id、 Cocoiru は Cocoiru が発行した報告 id、
 * セッションは呼び出し側の client_key (無ければ本文のハッシュ) を session id と組にする。
 * Discord / Cocoiru で鍵が無ければ null (受付側が 400 にする)。
 */
export function bountyIntakeKey(input: {
  platform: BountyIntakePlatform;
  clientKey: string | null;
  sessionId: string | null;
  fields: BountyIntakeFields;
}): string | null {
  const clientKey = (input.clientKey ?? "").trim();
  if (input.platform !== "session") return clientKey ? `${input.platform}:${clientKey}` : null;
  const sessionId = (input.sessionId ?? "").trim();
  if (clientKey) return `session:${sessionId}:key:${clientKey}`;
  const digest = createHash("sha256")
    .update(JSON.stringify([input.fields.project, input.fields.what_happened, input.fields.repro_steps]), "utf8")
    .digest("hex");
  return `session:${sessionId}:body:${digest}`;
}
// @ts-expect-error augur-inject
bountyIntakeKey = contract(bountyIntakeKey, { ...augurContract_1463dc51, contractId: 'bounty-intake-C-2', mode: 'observe', sample: 1, where: 'src/bounty/intake.ts:58', rule: 'contract-wrap', id: '1463dc51' }); /* augur-inject:contract-wrap:1463dc51 */
