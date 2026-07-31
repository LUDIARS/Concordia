import { Link } from "react-router-dom";

import { HarnessAuditSection } from "./subsidiaries/HarnessAuditSection.js";
import { SubsidiariesSection } from "./subsidiaries/SubsidiariesSection.js";

/**
 * 子会社 Delegation ダッシュボード。
 *  - ハーネス監査ログ: ガード判定の裏取り。
 *  - 子会社管理: 出張先 (別 Discord/Slack)・専用 Bot・専用 delegation・ガードスコープ。
 * 共通ハーネスルールの編集はマニュアルページへ移設した。
 * spec/feature/subsidiary-delegation.md。
 */
export function Subsidiaries() {
  return (
    <div className="flex flex-col gap-8 max-w-5xl">
      <div className="bg-surface border border-border rounded p-3 text-xs text-subtle">
        共通ハーネスルール (ガードの allow / block ポリシー) の編集は
        <Link to="/manuals" className="text-accent"> マニュアル</Link> ページに移動しました。
      </div>
      <HarnessAuditSection />
      <SubsidiariesSection />
    </div>
  );
}
