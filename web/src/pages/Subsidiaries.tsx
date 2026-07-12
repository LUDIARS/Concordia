import { useEffect, useState, useCallback } from "react";
import {
  api,
  fmtTs,
  type HarnessRule,
  type HarnessAuditRow,
  type HarnessAuditDecision,
  type HarnessAuditEvent,
  type SubsidiarySummary,
  type SubsidiaryInput,
  type SubsidiaryDelegation,
  type SubsidiaryLock,
  type SubsidiaryRequest,
  type DelegationTemplateLite,
} from "../api.js";
import { SubsidiaryProjectSpawnForm } from "../components/SubsidiaryProjectSpawnForm.js";
import { HarnessRulesSection } from "./subsidiaries/HarnessRulesSection.js";
import { HarnessAuditSection } from "./subsidiaries/HarnessAuditSection.js";
import { SubsidiariesSection } from "./subsidiaries/SubsidiariesSection.js";

/**
 * 子会社 Delegation ダッシュボード。
 *  - 共通ハーネスルール: 子会社ガード (Sonnet) のポリシーを「強固に設定」するセクション。
 *  - 子会社管理: 出張先 (別 Discord/Slack)・専用 Bot・専用 delegation・ガードスコープ。
 * spec/feature/subsidiary-delegation.md。
 */
export function Subsidiaries() {
  return (
    <div className="flex flex-col gap-8 max-w-5xl">
      <HarnessRulesSection />
      <HarnessAuditSection />
      <SubsidiariesSection />
    </div>
  );
}
