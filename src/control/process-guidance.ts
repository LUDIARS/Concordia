// @spec spec/feature/project-harness-policy.md — 必須設定が有効なプロジェクトへ渡す実装手順
import type { StartupRequirements } from "./startup-policy-requirements.js";
import { resolveMajorInjectText, type MajorInjectResolver } from "./major-inject-resolver.js";

export const PROCESS_GUIDANCE_HEADER = "[Cc 必須プロセス]";

/**
 * 必須設定 (DDD / 作業契約 / テスト / オンタイム) が一つでも有効なプロジェクトに、
 * コードを書く前後の手順を 1 束で渡す。旗の真偽値だけでは「何をどの順で揃えるか」が
 * 伝わらず、ゲートに止められてから手順を探すことになるため、注入文自体に手順を持たせる。
 *
 * 純関数。ファイルの存在確認や許可判定はしない (実行許可は元の人間の指示に従う)。
 */
export function buildProcessGuidance(required: StartupRequirements | null, projectRoot?: string, majorInject?: MajorInjectResolver): string | null {
  if (!required || !(required.ddd || required.workContract || required.tests || required.ontime)) return null;
  const root = (projectRoot ?? "<project>").replace(/[\/]+$/, "");
  const steps: string[] = [];
  if (required.ddd) {
    steps.push(resolveMajorInjectText("session.process_guidance.value", majorInject, { project_root: root }));
    steps.push(resolveMajorInjectText("session.process_guidance.domain", majorInject, { project_root: root }));
  }
  if (required.workContract) {
    steps.push(resolveMajorInjectText("session.process_guidance.contract", majorInject));
  }
  steps.push(required.tests || required.ontime ? resolveMajorInjectText("session.process_guidance.implementation", majorInject, {
    project_root: root,
    contract_clause: required.ontime ? " / contracts (augur.contracts.json の契約 ID と observe 述語)" : "",
  }) : resolveMajorInjectText("session.process_guidance.implementation_basic", majorInject));
  steps.push(resolveMajorInjectText("session.process_guidance.validation", majorInject));
  steps.push(resolveMajorInjectText("session.process_guidance.report", majorInject));
  const lines = [resolveMajorInjectText("session.process_guidance", majorInject, {
    project_root: root, steps: steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
  })];
  if (required.ddd) lines.push(resolveMajorInjectText("session.process_guidance.gate", majorInject, { project_root: root }));
  if (required.ddd) lines.push(resolveMajorInjectText("session.context.ddd_report", majorInject));
  return lines.join("\n");
}
