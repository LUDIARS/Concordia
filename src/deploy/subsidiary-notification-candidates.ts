import type { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import type { SubsidiaryDeploymentCandidate } from "./deployment-targets.js";

/** @implements spec/feature/project-notification-preferences.md — 子会社の受付と登録済み通知先を解決する。 */
export function listSubsidiaryNotificationCandidates(
  repo: Pick<SubsidiaryRepo, "list" | "listDeployProjects" | "listDeployNotify">,
  includeIntakeChannels: boolean,
): SubsidiaryDeploymentCandidate[] {
  return repo.list().flatMap((subsidiary) => {
    const common = {
      subsidiaryId: subsidiary.id,
      enabled: subsidiary.enabled === 1,
      projects: repo.listDeployProjects(subsidiary.id),
      intakeChannelId: subsidiary.channel_id,
      botTokenEnc: subsidiary.bot_token_enc,
    };
    const candidates: SubsidiaryDeploymentCandidate[] = repo.listDeployNotify(subsidiary.id)
      .filter((target) => target.enabled === 1)
      .map((target) => ({ ...common, kind: target.kind, target: target.target }));
    // 明示的に選んだ子会社には、追加通知先の登録がなくても受付へ届ける。
    // 未設定プロジェクトの既存配送規則には受付を追加しない。
    if (includeIntakeChannels && subsidiary.channel_id) {
      candidates.push({ ...common, kind: "subsidiary-channel", target: subsidiary.channel_id });
    }
    return candidates;
  });
}
