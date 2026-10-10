/**
 * デイリーゴールの登録者の判断 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 2. 許可と権限 / CC-DG-INV-01 / CC-DG-INV-04
 *
 * 登録は人間本人の投稿だけで成立する。 許可範囲は登録者の役職を超えられない
 * (merge / deploy は merge_pr = 管理職以上)。 権限を超える許可は不可に落とす。
 */

import { capabilityAllowed } from "../staff/roles.js";
import type { GoalActor, GoalPermissions, PermissionKey } from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:0356489a */
import augurContract_c63c50dc from './authorize-confirmer.contract.js'; /* augur-inject:contract-predicate:8ed0fc87 */

export type ConfirmerAuthorization = { ok: true } | { ok: false; reason: string };

/**
 * 登録者の本人性と許可範囲の上限を判定する。
 * bot・webhook・system は登録できない。 登録自体は session_spawn (ヒラ社員以上)、
 * merge / deploy を可にするには merge_pr (管理職以上) が要る。
 */
export function authorizeConfirmer(actor: GoalActor, permissions: GoalPermissions): ConfirmerAuthorization {
  if (actor.isBot || actor.isWebhook || !actor.userId.trim()) {
    return { ok: false, reason: "デイリーゴールは人間本人の投稿でだけ登録できます (bot・webhook は不可)。" };
  }
  if (!capabilityAllowed(actor.role, "session_spawn")) {
    return { ok: false, reason: "デイリーゴールを登録する権限 (セッションの起動) がありません。" };
  }
  if ((permissions.merge || permissions.deploy) && !capabilityAllowed(actor.role, "merge_pr")) {
    return { ok: false, reason: "マージ・反映を許可するには管理職以上の役職が必要です。許可範囲を見直してください。" };
  }
  return { ok: true };
}
// @ts-expect-error augur-inject
authorizeConfirmer = contract(authorizeConfirmer, { ...augurContract_c63c50dc, contractId: 'dg-C-2', mode: 'observe', sample: 1, where: 'src/daily-goal-run/confirmation-policy.ts:73', rule: 'contract-wrap', id: 'c63c50dc' }); /* augur-inject:contract-wrap:c63c50dc */

/** 登録者の権限を超える許可 (merge / deploy) を不可に落とす。 落とした項目を返す。 */
export function capPermissions(actor: GoalActor, permissions: GoalPermissions): { permissions: GoalPermissions; dropped: PermissionKey[] } {
  if (capabilityAllowed(actor.role, "merge_pr")) return { permissions: { ...permissions }, dropped: [] };
  const dropped = (["merge", "deploy"] as const).filter((key) => permissions[key]);
  return { permissions: { ...permissions, merge: false, deploy: false }, dropped: [...dropped] };
}
