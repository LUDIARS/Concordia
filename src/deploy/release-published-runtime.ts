import type Database from "better-sqlite3";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import { resolveDeploymentTargets } from "./deployment-targets.js";
import type { ReleaseNoticeLedger, ReleaseNoticeLookup } from "./release-published.js";
import type { DeployNotifyTarget } from "./service-deployed.js";

/** Durable at-most-once claim for a Revisor release event. */
export class SqliteReleaseNoticeLedger implements ReleaseNoticeLedger {
  constructor(private readonly db: Database.Database) {}

  claim(repository: string, tag: string): boolean {
    return this.db.prepare(
      "INSERT INTO release_notice_ledger(repository, tag, received_at) VALUES (?, ?, ?) ON CONFLICT(repository, tag) DO NOTHING",
    ).run(repository, tag, Date.now()).changes === 1;
  }
}

/**
 * リリース通知の宛先を本社 + 担当子会社に解決する。
 *
 * デプロイ通知が `code` で引くのに対し、 こちらは `repository` (owner/name) で引く。
 * Revisor が送るリリースイベントは catalog の service code を持たないため。
 *
 * プロジェクト個別の `deploy_notify` は**使わない**。 あれは「反映した」を知らせる宛先で、
 * 「公開した」の宛先とは別物。 混ぜると、デプロイ通知だけを受けたい webhook にリリースまで
 * 流れる。 本社と子会社の判定 (CC-INV-06 の fail-closed) だけを共有する。
 */
export function createReleaseNoticeLookup(input: {
  projects: Pick<ProjectCodesRepo, "findByRepoOrigin">;
  subsidiaries: Pick<SubsidiaryRepo, "list" | "listDeployProjects" | "listDeployNotify">;
  hqTargets: () => Array<{ kind: "discord" | "slack" | "cc-channel"; target: string }>;
}): ReleaseNoticeLookup {
  return {
    targets: (repository) => {
      const row = input.projects.findByRepoOrigin(repository);
      // 未登録リポジトリでも本社へは流す。 本社は無条件で、 絞り込みは子会社側の規則。
      if (!row) return dedupeHq(input.hqTargets());
      const subsidiaries = input.subsidiaries.list().flatMap((subsidiary) =>
        input.subsidiaries.listDeployNotify(subsidiary.id)
          .filter((target) => target.enabled === 1)
          .map((target) => ({
            subsidiaryId: subsidiary.id,
            enabled: subsidiary.enabled === 1,
            projects: input.subsidiaries.listDeployProjects(subsidiary.id),
            kind: target.kind,
            target: target.target,
            intakeChannelId: subsidiary.channel_id,
            botTokenEnc: subsidiary.bot_token_enc,
          })));
      return resolveDeploymentTargets({
        project: row.project,
        hq: input.hqTargets(),
        projectTargets: [],
        workflow: row.revisor_workflow,
        subsidiaries,
      }).targets;
    },
  };
}

function dedupeHq(targets: readonly DeployNotifyTarget[]): DeployNotifyTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}:${target.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
