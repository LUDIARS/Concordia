/**
 * 月次予算の倍率の設定画面に出す、 guild ごとのロール一覧 (spec/feature/usage-budgets.md §3.1 §6)。
 *
 * 値は Discord の Bot が読む (discord/member-roles.ts) が、 受け取る API (api/usage-budgets.ts) と
 * 配線 (api/register-core.ts) は core 側なので、 型だけをここに置いて chat 層を import させない。
 *
 * @implements SPEC-USAGE-BUDGET-MULTIPLIER
 */

export interface GuildRoleList {
  guild_id: string;
  guild_name: string;
  roles: Array<{ id: string; name: string }>;
}
