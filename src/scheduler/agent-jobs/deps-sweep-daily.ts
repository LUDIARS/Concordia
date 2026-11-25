/**
 * 日次依存関係点検 (`deps-sweep-daily`) の外部エージェント版。
 * 公開リポのマニフェストの所在と前回の要約から、点検報告と依存更新の提案を受け取る。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 依存点検
 */

import { composeAgentBody } from "./body.js";
import { CLOUD_PROPOSAL_FORMAT } from "./kaizen-proposal.js";
import type { AgentJobSpec } from "./types.js";
import type { DependencyDeclaration } from "../agent-job-sources/dependency-declarations.js";
import { contract } from '../ontime-runtime.js'; /* augur-inject:import:e0598a6a */
import augurContract_9faef046 from './deps-sweep-daily.contract.js'; /* augur-inject:contract-predicate:d427b56d */

export const DEPS_SWEEP_DAILY_JOB = "deps-sweep-daily";

export interface DependencyRepo {
  name: string;
  code: string | null;
  /** 公開 GitHub の https URL (資格情報なし)。 */
  url: string;
  /** マニフェストの公開 URL (package.json / Cargo.toml など)。 */
  manifests: string[];
  /** main の package.json 系の依存宣言 (名前と版指定)。 外部エージェントは URL を読めないため Cc が読んで渡す。 */
  declarations?: DependencyDeclaration[];
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * 純関数: 発火日ごとに先頭を 1 つずらす。 data は上限超過で末尾から落ちるため、
 * 毎日同じリポだけが渡らないよう、 日を追って全リポを一巡させる。
 */
export function rotateByDay<T>(items: readonly T[], firedAt: Date): T[] {
  if (items.length === 0) return [];
  const offset = Math.floor(firedAt.getTime() / DAY_MS) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

export interface DepsSweepSources {
  dependencyRepos(): Promise<DependencyRepo[]>;
  lastDoneSummary(job: string): string | null;
}

export function createDepsSweepDailyJob(sources: DepsSweepSources): AgentJobSpec {
  return {
    jobName: DEPS_SWEEP_DAILY_JOB,
    resultKind: "提案",
    body: composeAgentBody([
      "LUDIARS の公開リポの依存関係を点検し、報告と修正提案を返してください。実装は Cc が Codex Cloud に割り当てます。",
      "",
      "params.data.repos の各リポの declarations (main の package.json の依存の名前と版指定) を見て、 既知の脆弱性・大きく遅れた版・非互換の恐れがある更新候補と、既存挙動への影響の見立てを挙げてください。",
      "manifests は所在の参考です (URL を読みに行く必要はありません)。 declarations の無いマニフェスト (Cargo.toml など) は所在だけの報告で構いません。",
      "data は上限のため日替わりで一部のリポだけが入ります (truncated は今回入らなかった件数)。",
      "前回の要約 (previous_summary) から変わった点を先に書き、",
      "件数の合計より「どのパッケージが問題か」が分かる形を優先してください。",
      ...CLOUD_PROPOSAL_FORMAT,
      "target_repo は params.data.repos の code を使用してください。code がない対象は detail.items に記してください。",
      "パッケージ名・現在版→目標版、脆弱性や非互換の根拠、lockfile の更新と検証の指示を含めてください。",
      "kind=cloud_fix はリポ内の依存更新と最小限の互換修正・回帰テストに限定します。major 更新は既存挙動を維持できる根拠と回帰テストの手順を示せる場合だけ提案してください。",
      "安全に更新できる根拠がない候補は detail.items へ記載してください。更新案がない日も点検結果を返してください。",
    ]),
    async buildData(context) {
      const repos = rotateByDay((await sources.dependencyRepos())
        .filter((repo) => repo.manifests.length > 0), context.firedAt)
        .map((repo) => ({
          name: repo.name, code: repo.code, url: repo.url, manifests: repo.manifests, declarations: repo.declarations ?? [],
        }));
      return { previous_summary: sources.lastDoneSummary(DEPS_SWEEP_DAILY_JOB), repos };
    },
  };
}
// @ts-expect-error augur-inject
createDepsSweepDailyJob = contract(createDepsSweepDailyJob, { ...augurContract_9faef046, contractId: 'cron-deps-cloud-C-53', mode: 'observe', sample: 1, where: 'src/scheduler/agent-jobs/deps-sweep-daily.ts:28', rule: 'contract-wrap', id: '9faef046' }); /* augur-inject:contract-wrap:9faef046 */
