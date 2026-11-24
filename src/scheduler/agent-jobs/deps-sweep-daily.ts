/**
 * 日次依存関係点検 (`deps-sweep-daily`) の外部エージェント版。
 * 公開リポのマニフェストの所在 (GitHub URL) と前回の点検結果の要約を渡し、 報告を返してもらう (PR は作らない)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 依存点検
 */

import { composeAgentBody } from "./body.js";
import type { AgentJobSpec } from "./types.js";

export const DEPS_SWEEP_DAILY_JOB = "deps-sweep-daily";

export interface DependencyRepo {
  name: string;
  code: string | null;
  /** 公開 GitHub の https URL (資格情報なし)。 */
  url: string;
  /** リポ root からの相対パス (package.json / Cargo.toml など)。 */
  manifests: string[];
}

export interface DepsSweepSources {
  dependencyRepos(): Promise<DependencyRepo[]>;
  lastDoneSummary(job: string): string | null;
}

export function createDepsSweepDailyJob(sources: DepsSweepSources): AgentJobSpec {
  return {
    jobName: DEPS_SWEEP_DAILY_JOB,
    resultKind: "報告",
    body: composeAgentBody([
      "LUDIARS の公開リポの依存関係を点検して報告する回です。 点検だけを行います。",
      "",
      "params.data.repos の各マニフェスト (GitHub の公開 URL) を読み、 更新候補と既存挙動への影響の見立てを挙げてください。",
      "major 更新は候補として挙げるだけです。 前回の要約 (previous_summary) から変わった点を先に書き、",
      "件数の合計より「どのパッケージが問題か」が分かる形を優先してください。",
    ]),
    async buildData() {
      const repos = (await sources.dependencyRepos())
        .filter((repo) => repo.manifests.length > 0)
        .map((repo) => ({ name: repo.name, code: repo.code, url: repo.url, manifests: repo.manifests }));
      return { previous_summary: sources.lastDoneSummary(DEPS_SWEEP_DAILY_JOB), repos };
    },
  };
}
