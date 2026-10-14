/**
 * bug-bounty の受付より後段 (仕分け・再審・修正・反映確認) の組み立て (spec/feature/bug-bounty.md §5-§7)。
 *
 * use case 同士のつなぎ (採用 → Actio タスク・hotfix、判定の変更 → 報奨の見直し) と、定期の処理の順番をここに
 * 閉じる。 外部 (Actio・委託・PR・通知・報奨) は port で受け取り、bootstrap は adapter を渡すだけにする。
 *
 * @implements SPEC-BOUNTY-TRIAGE
 * @implements SPEC-BOUNTY-FIX
 * @implements SPEC-BOUNTY-CLOSE
 */

import type { BountyReporterKey, BountyReporterRow } from "../db/bounty-reporters-repo.js";
import { BountyCloseService, type BountyCloseDeps, type BountyResolvedReport } from "./close-service.js";
import { BountyFixService } from "./fix-service.js";
import { BountyJudgementService } from "./judgement-service.js";
import type {
  BountyActioPort,
  BountyDelegationPort,
  BountyLedger,
  BountyNotifierPort,
  BountyPrLookupPort,
  BountyProjectsPort,
  BountyRewardPort,
} from "./ports.js";
import { BountyTriageService } from "./triage-service.js";

export interface BountyFlowDeps {
  ledger: BountyLedger;
  reporters: { find(id: string): BountyReporterRow | null; findByKey(key: BountyReporterKey): BountyReporterRow | null };
  projects: BountyProjectsPort;
  delegation: BountyDelegationPort;
  actio: BountyActioPort;
  prs: BountyPrLookupPort;
  notifier: BountyNotifierPort;
  rewards: BountyRewardPort;
  sessionActive(sessionId: string): boolean;
  hotfixDailyLimit(): number;
  /** バウンティ企画 (報奨の上書き、§18.4)。 */
  events?: BountyCloseDeps["events"];
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

export interface BountyFlow {
  triage: BountyTriageService;
  fix: BountyFixService;
  close: BountyCloseService;
  judgement: BountyJudgementService;
  /** 定期の処理 (仕分けの起動と照合 → 修正の再試行と照合 → Actio done の知らせ)。 */
  tick(): Promise<void>;
  /** デプロイで反映した報告を閉じ、通知に載せる行を返す (service-deployed-notify の port)。 */
  resolveDeployment(input: { project: string; code: string; hash: string; pullRequests: readonly number[] }): Promise<BountyResolvedReport[]>;
}

export function createBountyFlow(deps: BountyFlowDeps): BountyFlow {
  const fix = new BountyFixService({
    ledger: deps.ledger,
    projects: deps.projects,
    actio: deps.actio,
    delegation: deps.delegation,
    prs: deps.prs,
    notifier: deps.notifier,
    hotfixDailyLimit: deps.hotfixDailyLimit,
    ...(deps.log ? { log: deps.log } : {}),
  });
  const close = new BountyCloseService({
    ledger: deps.ledger,
    reporters: deps.reporters,
    rewards: deps.rewards,
    actio: deps.actio,
    notifier: deps.notifier,
    ...(deps.events ? { events: deps.events } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  const triage = new BountyTriageService({
    ledger: deps.ledger,
    projects: deps.projects,
    delegation: deps.delegation,
    notifier: deps.notifier,
    onAccepted: (reportId) => fix.onAccepted(reportId),
    ...(deps.log ? { log: deps.log } : {}),
  });
  const judgement = new BountyJudgementService({
    ledger: deps.ledger,
    reporters: deps.reporters,
    sessionActive: deps.sessionActive,
    notifier: deps.notifier,
    onAccepted: (reportId) => fix.onAccepted(reportId),
    reconcileReward: (reportId, reason) => close.reconcileReward(reportId, reason),
  });
  return {
    triage,
    fix,
    close,
    judgement,
    tick: async () => {
      await triage.tick();
      await fix.tick();
      await close.tick();
    },
    resolveDeployment: (input) => close.onDeployed(input),
  };
}
