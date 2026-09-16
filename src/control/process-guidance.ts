// @spec spec/feature/project-harness-policy.md — 必須設定が有効なプロジェクトへ渡す実装手順
import type { StartupRequirements } from "./startup-policy-requirements.js";

export const PROCESS_GUIDANCE_HEADER = "[Cc DDD/契約プロセス]";

/**
 * 必須設定 (DDD / 作業契約 / テスト / オンタイム) が一つでも有効なプロジェクトに、
 * コードを書く前後の手順を 1 束で渡す。旗の真偽値だけでは「何をどの順で揃えるか」が
 * 伝わらず、ゲートに止められてから手順を探すことになるため、注入文自体に手順を持たせる。
 *
 * 純関数。ファイルの存在確認や許可判定はしない (実行許可は元の人間の指示に従う)。
 */
export function buildProcessGuidance(required: StartupRequirements | null, projectRoot?: string): string | null {
  if (!required || !(required.ddd || required.workContract || required.tests || required.ontime)) return null;
  const root = (projectRoot ?? "<project>").replace(/[\/]+$/, "");
  const steps: string[] = [];
  if (required.ddd) {
    steps.push(`価値: ${root}/spec/ux/ の価値 ID・シナリオを選び、失うと困る利用者の状態を書く。無ければ先に spec/ux/product.md を書く。`);
    steps.push(`所属: ${root}/spec/domains/*.domain.json の membership (pathPattern) と specRefs を確認する (anatomia where)。触るファイルが未宣言なら実装より前に宣言し、src と tests を対で載せる。状態所有者と不変条件を spec に残す。`);
  }
  if (required.workContract) {
    steps.push("契約: 目的・対象・変更内容・受入条件を設計として整理し work-phase を confirmation で記録する。人間の開始指示 (approval_reference) を受けてから implementation へ進む。契約未確定の間はコード編集が deny される。");
  }
  steps.push(required.tests || required.ontime
    ? `実装: 業務判断は純関数、外部 I/O は adapter、手順は use case に分ける。テストを同じ変更単位で書き、${root}/cc.acceptance.json の implementations に source / tests${required.ontime ? " / contracts (augur.contracts.json の契約 ID と observe 述語)" : ""} を対応付ける。提出コマンドはこの対応が無いと deny される。`
    : "実装: 業務判断は純関数、外部 I/O は adapter、手順は use case に分ける。テストを同じ変更単位で書く。");
  steps.push("検証: `git diff | anatomia verify` と登録テストの回帰。実行はユーザの許可範囲に従い、未実施はそのまま記録する。");
  steps.push("提出: PR に価値 ID・不変条件・変更した境界・復旧方法・実施/未実施の検証を記す。");
  const lines = [
    `${PROCESS_GUIDANCE_HEADER} 必須設定が有効です。コード編集前に次の順で進め、各手の証跡を残してください。`,
    ...steps.map((step, index) => `${index + 1}. ${step}`),
  ];
  if (required.ddd) lines.push(`編集ゲートは spec/ux が空、または specRefs 付きドメインの membership に一致しないファイルの編集を deny します。方針の正本: ${root}/spec/architecture/ddd.md (無ければ作成が先)。`);
  return lines.join("\n");
}
