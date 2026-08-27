/**
 * cron ジョブの fanout 対象の組み立て。
 *
 * 「チームごとに 1 本ずつ起動する」 ような定時ジョブ (朝礼 / 定例) のために、
 * 1 回の発火を対象ごとの invoke へ展開する。 cron-jobs.ts は静的な定義表なので、
 * DB を引く対象列挙はこちら側に置く。
 */

/** fanout 1 対象分の invoke パラメータ。 */
export interface CronFanoutTarget {
  /** ログと triggered_by に載せる識別子 (人間が読める短い値)。 */
  key: string;
  /** ジョブ既定の args に上書きマージする値。 */
  args: Record<string, unknown>;
  /** delegation invoke の options に上書きマージする値。 */
  options?: Record<string, unknown>;
}

/** fanout 対象を列挙するのに必要なチーム情報 (teams-repo の行の部分集合)。 */
export interface FanoutTeam {
  id: string;
  slug: string;
  name: string;
  /** 一時停止した時刻 (epoch-ms)。 null / 未指定 = 稼働中。 */
  suspended_at?: number | null;
}

/**
 * チームごとの fanout 対象を作る。
 *
 * - **一時停止中 (`suspended_at` 有り) のチームは対象から外す** (2026-08-27 neco 指示:
 *   作業していないチームは一時的に止められる)。 朝礼 / 定例 / issue scout / タスク整理の
 *   定時 delegation が空振りで起動し続けるのを避ける。
 * - `options.team` に team id を渡すことで、 起動した delegation run が
 *   そのチームに帰属する (delegation service が team_id を解決する)。
 * - 起動順を安定させるため slug 昇順に整列する。
 * - slug が空のチームは識別子を作れないため id を key に使う。
 *
 * @implements spec/feature/teams.md §4.5
 */
export function buildTeamFanoutTargets(teams: readonly FanoutTeam[]): CronFanoutTarget[] {
  return teams
    .filter((team) => team.suspended_at == null)
    .sort((a, b) => (a.slug || a.id).localeCompare(b.slug || b.id))
    .map((team) => ({
      key: team.slug || team.id,
      args: {
        team_id: team.id,
        team_slug: team.slug,
        team_name: team.name,
      },
      options: { team: team.id },
    }));
}
