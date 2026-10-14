import { contract } from "./ontime-runtime.js"; /* augur-inject:import:e6a5c426 */
import augurContract_1382b454 from "./service-deployed.contract.js"; /* augur-inject:contract-predicate:246da252 */
import augurContract_bfd8feb2 from "./service-deployed.contract.js"; /* augur-inject:contract-predicate:bfd8feb2 */
import augurContract_5a39dcf8 from "./service-deployed.contract.js"; /* augur-inject:contract-predicate:ecca4d2 */
export type DeployNotifyTarget = { kind: "discord" | "slack" | "cc-channel" | "subsidiary-channel"; target: string; subsidiaryId?: string; botTokenEnc?: string | null };

export interface ServiceDeployedEvent { code: string; previousHash: string; currentHash: string; version: string; startedAt: string; restartCount: number; }
export interface RevisorChanges { from: string; to: string; commits: Array<{ sha: string; subject: string }>; pullRequests: Array<{ number: number; title: string; author: string; mergedAt: string | null }>; markdown: string; notice: string; }
export interface DeploymentLedger { claim(code: string, currentHash: string): boolean; }
export interface DeploymentDelivery { discord(target: string, content: string): Promise<void>; slack(target: string, content: string): Promise<void>; ccChannel(content: string): Promise<void>; subsidiaryChannel(target: string, botTokenEnc: string | null, content: string): Promise<void>; }
export interface DeploymentLookup {
  findProject(code: string): { repo_origin: string | null; deploy_notify: DeployNotifyTarget[] } | null;
  changes(repository: string, from: string, to: string): Promise<RevisorChanges | null>;
  /** 本社の無条件宛先。 project registry に行が無いサービスでも本社には反映を知らせる (CC-INV-06)。 */
  hqTargets?(): DeployNotifyTarget[];
  /**
   * このデプロイで反映したバグ報告 (bug-bounty の port、 spec/feature/bug-bounty.md §7)。 反映確認と報奨は
   * 呼ばれた側が行い、 ここは通知に載せる行だけを受け取る。 Revisor の変更一覧を取れたデプロイだけで呼ぶ。
   */
  resolvedBountyReports?(input: { code: string; currentHash: string; pullRequests: readonly number[] }): Promise<DeployedBountyReport[]>;
}
/** デプロイ通知の「解決したバグ報告」の 1 行。 報告 id・公開用の題名・公開名だけ (原文・受付口を含めない)。 */
export interface DeployedBountyReport { reportId: string; title: string; reporter: string; }
/** 通知に載せる「解決したバグ報告」の上限。 */
const MAX_BOUNTY_LINES = 10;
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/** 報告由来の文 (題名・公開名) を mention・リンクにならない 1 行へ。 */
function inertLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120)
    .replace(/@/g, `@${ZERO_WIDTH_SPACE}`)
    .replace(/<(?=[@#:&!])/g, `<${ZERO_WIDTH_SPACE}`)
    .replace(/https?:\/\//gi, (scheme) => `${scheme.slice(0, -2)}${ZERO_WIDTH_SPACE}//`);
}

/**
 * 「解決したバグ報告」の節。 無ければ空文字。
 * @implements SPEC-BOUNTY-CLOSE
 */
export function composeResolvedBountySection(reports: readonly DeployedBountyReport[]): string {
  if (reports.length === 0) return "";
  const lines = reports.slice(0, MAX_BOUNTY_LINES).map((report) =>
    `- \`${report.reportId.replace(/[^A-Za-z0-9_-]/g, "")}\` ${inertLine(report.title)} (報告: ${inertLine(report.reporter)})`);
  const more = reports.length > MAX_BOUNTY_LINES ? [`- ほか ${reports.length - MAX_BOUNTY_LINES} 件`] : [];
  return ["解決したバグ報告:", ...lines, ...more].join("\n");
}
export interface DeploymentDeliveryResult {
  target: Pick<DeployNotifyTarget, "kind" | "target" | "subsidiaryId">;
  error?: string;
}
export interface DeploymentOutcome {
  duplicate: boolean;
  delivered: DeploymentDeliveryResult[];
  failed: DeploymentDeliveryResult[];
  fallback: boolean;
}

export function composeDeploymentNotice(event: ServiceDeployedEvent, changes: RevisorChanges | null, bountyReports: readonly DeployedBountyReport[] = []): string {
  const head = `[${event.code}] デプロイ反映 ${shortHash(event.previousHash)}→${shortHash(event.currentHash)} / ${event.version}`;
  if (!changes) return `${head}\n反映のみ（Revisor の差分情報を取得できませんでした）`;
  const notice = changes.notice.trim().split(/\r?\n/).slice(0, 10).join("\n");
  return [
    head,
    `merged PR ${changes.pullRequests.length} 本`,
    notice ? `> ${notice.replace(/\n/g, "\n> ")}` : "",
    composeResolvedBountySection(bountyReports),
  ].filter(Boolean).join("\n");
}

// @ts-expect-error augur-inject
composeDeploymentNotice = contract(composeDeploymentNotice, { ...augurContract_bfd8feb2, contractId: "C-2", mode: "observe", sample: 1, where: "src/deploy/service-deployed.ts:24", rule: "contract-wrap", id: "bfd8feb2" }); /* augur-inject:contract-wrap:bfd8feb2 */

export async function deliverDeploymentNotice(input: { targets: readonly DeployNotifyTarget[]; content: string; delivery: DeploymentDelivery }): Promise<Pick<DeploymentOutcome, "delivered" | "failed">> {
  const delivered: DeploymentDeliveryResult[] = [];
  const failed: DeploymentDeliveryResult[] = [];
  for (const target of input.targets) {
    const resultTarget = { kind: target.kind, target: target.target, ...(target.subsidiaryId ? { subsidiaryId: target.subsidiaryId } : {}) };
    try {
      if (target.kind === "discord") await input.delivery.discord(target.target, input.content);
      else if (target.kind === "slack") await input.delivery.slack(target.target, input.content);
      else if (target.kind === "cc-channel") await input.delivery.ccChannel(input.content);
      // 子会社 Bot 未設定 (botTokenEnc null) は runtime 側で本社 Bot へ倒す。 ここでは弾かない。
      else await input.delivery.subsidiaryChannel(target.target, target.botTokenEnc ?? null, input.content);
      delivered.push({ target: resultTarget });
    } catch (error) {
      failed.push({ target: resultTarget, error: error instanceof Error ? error.message : "delivery failed" });
    }
  }
  return { delivered, failed };
}

// @ts-expect-error augur-inject
deliverDeploymentNotice = contract(deliverDeploymentNotice, { ...augurContract_5a39dcf8, contractId: "C-3", mode: "observe", sample: 1, where: "src/deploy/service-deployed.ts:33", rule: "contract-wrap", id: "5a39dcf8" }); /* augur-inject:contract-wrap:5a39dcf8 */

export async function handleServiceDeployment(input: { event: ServiceDeployedEvent; ledger: DeploymentLedger; lookup: DeploymentLookup; delivery: DeploymentDelivery }): Promise<DeploymentOutcome> {
  if (!input.ledger.claim(input.event.code, input.event.currentHash)) return { duplicate: true, delivered: [], failed: [], fallback: false };
  const project = input.lookup.findProject(input.event.code);
  if (!project) {
    // registry に無いサービス (Excubitor だけが知るもの) でも本社には「反映のみ」で知らせる。
    const hq = input.lookup.hqTargets?.() ?? [];
    const results = await deliverDeploymentNotice({ targets: hq, content: composeDeploymentNotice(input.event, null), delivery: input.delivery });
    return { duplicate: false, ...results, fallback: true };
  }
  let changes: RevisorChanges | null = null;
  if (project.repo_origin) { try { changes = await input.lookup.changes(project.repo_origin, input.event.previousHash, input.event.currentHash); } catch { changes = null; } }
  // 反映確認は Revisor の変更一覧を取れたデプロイだけ。 失敗しても通知は止めない (CC-INV-06)。
  let bountyReports: DeployedBountyReport[] = [];
  if (changes && input.lookup.resolvedBountyReports) {
    try {
      bountyReports = await input.lookup.resolvedBountyReports({
        code: input.event.code, currentHash: input.event.currentHash, pullRequests: changes.pullRequests.map((pr) => pr.number),
      });
    } catch { bountyReports = []; }
  }
  const results = await deliverDeploymentNotice({ targets: project.deploy_notify, content: composeDeploymentNotice(input.event, changes, bountyReports), delivery: input.delivery });
  return { duplicate: false, ...results, fallback: changes === null };
}

// @ts-expect-error augur-inject
handleServiceDeployment = contract(handleServiceDeployment, { ...augurContract_1382b454, contractId: "C-1", mode: "observe", sample: 1, where: "src/deploy/service-deployed.ts:54", rule: "contract-wrap", id: "1382b454" }); /* augur-inject:contract-wrap:1382b454 */

function shortHash(hash: string): string { return hash.slice(0, 7); }
