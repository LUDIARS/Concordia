/**
 * デイリーゴールの確定判断 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 2. ゴールを確定する / CC-DG-INV-01 / CC-DG-INV-04
 *
 * 欠けた項目があれば確定しない。 確定は人間本人の操作だけで成立し、 許可範囲は
 * 確定者の役職を超えられない (merge / deploy は merge_pr = 管理職以上)。
 */

import { capabilityAllowed } from "../staff/roles.js";
import {
  DRAFT_FIELD_LABELS,
  PERMISSION_KEYS,
  type DraftField,
  type GoalActor,
  type GoalDraft,
  type GoalPermissions,
} from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:0356489a */
import augurContract_4582e312 from './validate-draft.contract.js'; /* augur-inject:contract-predicate:b22bdc13 */
import augurContract_c63c50dc from './authorize-confirmer.contract.js'; /* augur-inject:contract-predicate:8ed0fc87 */

export interface ValidDraft {
  project: string;
  repoPath: string;
  goalText: string;
  acceptance: string[];
  actioTaskIds: string[];
  permissions: GoalPermissions;
}

export type DraftValidation =
  | { ok: true; draft: ValidDraft }
  | { ok: false; missing: DraftField[] };

function cleanList(values: readonly string[] | null | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

/** 欠けている項目の一覧を返す。 許可範囲は 4 項目すべての明示 (true/false) が要る。 */
export function validateDraft(draft: GoalDraft): DraftValidation {
  const missing: DraftField[] = [];
  const project = draft.project?.trim() ?? "";
  const repoPath = draft.repoPath?.trim() ?? "";
  const goalText = draft.goalText?.trim() ?? "";
  const acceptance = cleanList(draft.acceptance);
  const actioTaskIds = cleanList(draft.actioTaskIds).map((id) => id.replace(/^actio:/, ""));
  if (!project || !repoPath) missing.push("project");
  if (!goalText) missing.push("goalText");
  if (acceptance.length === 0) missing.push("acceptance");
  if (actioTaskIds.length === 0) missing.push("actioTaskIds");
  const permissions: Partial<GoalPermissions> = {};
  for (const key of PERMISSION_KEYS) {
    const value = draft.permissions?.[key];
    if (typeof value !== "boolean") missing.push(key);
    else permissions[key] = value;
  }
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    draft: { project, repoPath, goalText, acceptance, actioTaskIds, permissions: permissions as GoalPermissions },
  };
}
// @ts-expect-error augur-inject
validateDraft = contract(validateDraft, { ...augurContract_4582e312, contractId: 'dg-C-1', mode: 'observe', sample: 1, where: 'src/daily-goal-run/confirmation-policy.ts:38', rule: 'contract-wrap', id: '4582e312' }); /* augur-inject:contract-wrap:4582e312 */

export function describeMissing(missing: readonly DraftField[]): string {
  return missing.map((field) => `- ${DRAFT_FIELD_LABELS[field]}`).join("\n");
}

export type ConfirmerAuthorization = { ok: true } | { ok: false; reason: string };

/**
 * 確定者の本人性と許可範囲の上限を判定する。
 * bot・webhook・system は確定できない。 確定自体は session_spawn (ヒラ社員以上)、
 * merge / deploy を可にするには merge_pr (管理職以上) が要る。
 */
export function authorizeConfirmer(actor: GoalActor, permissions: GoalPermissions): ConfirmerAuthorization {
  if (actor.isBot || actor.isWebhook || !actor.userId.trim()) {
    return { ok: false, reason: "デイリーゴールは人間本人の操作でだけ確定できます (bot・webhook は不可)。" };
  }
  if (!capabilityAllowed(actor.role, "session_spawn")) {
    return { ok: false, reason: "デイリーゴールを確定する権限 (セッションの起動) がありません。" };
  }
  if ((permissions.merge || permissions.deploy) && !capabilityAllowed(actor.role, "merge_pr")) {
    return { ok: false, reason: "マージ・反映を許可するには管理職以上の役職が必要です。許可範囲を見直してください。" };
  }
  return { ok: true };
}
// @ts-expect-error augur-inject
authorizeConfirmer = contract(authorizeConfirmer, { ...augurContract_c63c50dc, contractId: 'dg-C-2', mode: 'observe', sample: 1, where: 'src/daily-goal-run/confirmation-policy.ts:73', rule: 'contract-wrap', id: 'c63c50dc' }); /* augur-inject:contract-wrap:c63c50dc */

/** 許可範囲の自由入力 (例 `merge=no,test=yes,service=no,deploy=no`) を解釈する。 不明な項目は未指定のまま。 */
export function parsePermissionText(text: string | null | undefined): Partial<GoalPermissions> {
  const result: Partial<GoalPermissions> = {};
  for (const part of (text ?? "").split(/[,\s、]+/)) {
    const match = /^(merge|test|service|deploy)\s*[=:]\s*(yes|no|true|false|可|不可|on|off|1|0)$/i.exec(part.trim());
    if (!match) continue;
    const key = match[1]!.toLowerCase() as keyof GoalPermissions;
    result[key] = /^(yes|true|可|on|1)$/i.test(match[2]!);
  }
  return result;
}
