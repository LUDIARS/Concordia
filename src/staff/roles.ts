/**
 * 社員名簿の役職 → 権限モデル (純関数のみ)。
 *
 * 「LLM に触れた platform ユーザ」は全員 staff_members に記録され、 役職に応じて
 * 権限が付く。 リアクションワークフロー側に allowlist を置くのをやめ、 ここを唯一の
 * 判定源にする (spec/feature/staff-roster.md)。
 *
 *   ヒラ社員 (staff)     : 未登録 / 権限なし。 会話 (chat / inject) とリアクション
 *                          ワークフローの発火ができる。
 *   管理職   (manager)   : セッションの spawn / end-session と PR のマージができる。
 *   執行役員 (executive) : Cc の管理権限 = キルスイッチ (サービス起動/再起動) ができる。
 *
 * リアクションワークフローは**指示の簡略化**であって権限ではない (neco 2026-08-01)。
 * 絵文字は誰でも押せるが、 その指示が実行できるとは限らない — 中身が spawn や merge を
 * 要求するなら、 そこで改めて役職が問われる。
 *
 * 役職は上位が下位を包含する (executive は manager の権限も持つ)。
 */

export type StaffRole = "staff" | "manager" | "executive";

export const STAFF_ROLES: readonly StaffRole[] = ["staff", "manager", "executive"];

/** 役職の序列。 大きいほど上位。 */
const ROLE_RANK: Record<StaffRole, number> = {
  staff: 0,
  manager: 1,
  executive: 2,
};

/** 役職の日本語表示名 (WebUI / Discord 応答の両方で使う)。 */
export const STAFF_ROLE_LABEL: Record<StaffRole, string> = {
  staff: "ヒラ社員",
  manager: "管理職",
  executive: "執行役員",
};

/**
 * 権限が必要な操作。 「マニュアルを逐次作るのは面倒」 という要求により、 操作ごとの
 * 細かい設定は持たず、 ここの固定表 (操作 → 必要役職) だけで決める。
 */
export type StaffCapability =
  /** 会話 (chat 投稿 / セッションへの inject)。 未登録でも可。 */
  | "converse"
  /**
   * リアクションワークフローの発火。 これは「指示の簡略化」であって権限ではない
   * (neco 2026-08-01)。 誰が押してもよく、 指示の中身が要求する権限は別途課される。
   */
  | "reaction_workflow"
  /** セッションの spawn (/spawn・コントロールパネル・🤝 delegate-task)。 */
  | "session_spawn"
  /** セッションの end-session (/end-session・コントロールパネル)。 */
  | "session_end"
  /** PR のマージ (🔀 🚀 merge-pr・🔄 sync-project-main-after-merge)。 */
  | "merge_pr"
  /** キルスイッチ = Excubitor 経由のサービス起動 / 再起動 (/ex-run・/ex-reboot)。 */
  | "kill_switch";

export const STAFF_CAPABILITIES: readonly StaffCapability[] = [
  "converse",
  "reaction_workflow",
  "session_spawn",
  "session_end",
  "merge_pr",
  "kill_switch",
];

/** 各操作に必要な最低役職。 */
export const CAPABILITY_MIN_ROLE: Record<StaffCapability, StaffRole> = {
  converse: "staff",
  // リアクションワークフローは「指示の簡略化」であって権限ではない (neco 2026-08-01)。
  // 誰が絵文字を押してもよく、 その指示が実際に実行できるかは中身が要求する権限で決まる。
  // 例: 🔀 (merge-pr) は merge_pr、 🤝 (delegate-task) は session_spawn を別途要求する。
  reaction_workflow: "staff",
  session_spawn: "manager",
  session_end: "manager",
  // マージは着地させる破壊的操作なので spawn / end と同じ管理職以上に置く。
  merge_pr: "manager",
  kill_switch: "executive",
};

/** 操作の日本語説明 (WebUI の権限表に出す)。 */
export const CAPABILITY_LABEL: Record<StaffCapability, string> = {
  converse: "会話 (chat / inject)",
  reaction_workflow: "リアクションワークフローの発火 (指示の簡略化)",
  session_spawn: "セッションの起動 (spawn)",
  session_end: "セッションの終了 (end-session)",
  merge_pr: "PR のマージ",
  kill_switch: "キルスイッチ (サービス起動・再起動)",
};

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}

/** role が minimum 以上か。 未登録 (null) は staff 相当として扱う。 */
export function roleAtLeast(role: StaffRole | null | undefined, minimum: StaffRole): boolean {
  return ROLE_RANK[role ?? "staff"] >= ROLE_RANK[minimum];
}

/**
 * 未登録ユーザ (role=null) は staff 相当 = 会話のみ許可。 これにより
 * 「登録されていない人間は基本的に会話は出来るが権限が必要な操作は Deny」 になる。
 */
export function capabilityAllowed(
  role: StaffRole | null | undefined,
  capability: StaffCapability,
): boolean {
  return roleAtLeast(role, CAPABILITY_MIN_ROLE[capability]);
}

/** 役職ごとに許可される操作の一覧 (WebUI の説明表示用)。 */
export function capabilitiesForRole(role: StaffRole): StaffCapability[] {
  return STAFF_CAPABILITIES.filter((capability) => capabilityAllowed(role, capability));
}
