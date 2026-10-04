// @spec ハーネス信頼性の実装境界
import { contract } from './ontime-runtime.js'; /* augur-inject:import:c33cd10e */
import augurContract_831c01cb from './contracts/workflow.contract.js'; /* augur-inject:contract-predicate:ddd1de88 */
import augurContract_4367202b from './contracts/workflow-bug-bounty.contract.js'; /* augur-inject:contract-predicate:14f43760 */
export interface WorkflowGuidance {
  kind: "feature-investigation" | "work-management" | "harness-recovery" | "bug-bounty";
  services: string[];
  skill: string;
  advice: string;
  source: "deterministic";
}

/** Retrieval/workflow assistance only; never changes safety verdicts or the project being edited. */
export function workflowGuidance(prompt: string, tags: readonly string[] = []): WorkflowGuidance[] {
  // Quoted code and automatic control packets are not new human workflow requests.
  const text = prompt.replace(/```[\s\S]*?```/g, "").trim();
  if (/^\[(?:自動確認|Cc Session policy|Cc policy update)\]/.test(text)) return [];
  const routes: WorkflowGuidance[] = [];
  const investigation = /(?:調査|調べ|探して|確認|investigat|inspect|find|where)/i.test(text)
    && /(?:機能|仕様|実装|コード|設計|feature|implementation|code|specification)/i.test(text);
  if ((investigation || tags.includes("feature-investigation")) && !/(?:調査|調べ)(?:しない|なくて|不要)|(?:do not|don't) investigate/i.test(text)) routes.push({
    kind: "feature-investigation", services: ["Praeforma", "Anatomia"], skill: "cc-feature-investigation", source: "deterministic",
    advice: "機能調査は cc-feature-investigation を使う。Pfへの対象プロジェクト登録を確認し、登録済みならPfで仕様・UXと版、Anatomiaで対象プロジェクトの実装・依存を照合する。Pfの予定を実装済みと扱わず、未登録または不通なら従来の対象repo内の正本文書とソースに限定して続ける。",
  });
  const management = /(?:タスク|作業|進捗|残件|未完了|TODO|backlog|task|worklog)/i.test(text)
    && /(?:管理|整理|登録|追加|更新|棚卸|記録|確認|進捗|manage|organize|track|record|status|update|create)/i.test(text);
  if ((management || tags.includes("work-management")) && !/(?:管理|登録)(?:しない|不要)/.test(text)) routes.push({
    kind: "work-management", services: ["Actio", "Memoria"], skill: "cc-work-management", source: "deterministic",
    advice: "作業管理は cc-work-management を使う。Actioの既存タスク・担当・状態と、Memoriaのタスク参照・ノート・worklogを確認する。同じ仕事を両方へ新規登録せず既存IDを再利用する。登録や完了更新は元の依頼範囲を守る。",
  });
  if (/(?:コンパクション|圧縮|認証切れ|認証.*失効|compaction|expired.*auth)/i.test(text)
    && /(?:復旧|確認|直|引継|引き継|recover|check|fix)/i.test(text)) routes.push({
    kind: "harness-recovery", services: ["Concordia"], skill: "cc-harness-recovery", source: "deterministic",
    advice: "cc-harness-recovery で保存済みcheckpointと実観測を確認する。認証の再probeや結果不明のclear再送を自動実行しない。",
  });
  // 不具合の発見・報告先を述べる入力に、報告の経路だけを案内する (spec/feature/bug-bounty.md §8.1)。報告は自動で出さない。
  if (asksBugBountyRoute(text)) routes.push({
    kind: "bug-bounty", services: ["Concordia"], skill: "bug-bounty-report", source: "deterministic",
    advice: "作業の範囲外で仕組みの不具合を見つけたなら、bug-bounty-report スキル (Discord では /bug) で報告できる。この案内は経路を示すだけで、報告は自動で出さない。自分の作業で直すものは報告せず、同じ不具合を繰り返し報告せず、報告のために調査範囲を広げない。",
  });
  return routes;
}
// @ts-expect-error augur-inject
workflowGuidance = contract(workflowGuidance, { ...augurContract_4367202b, contractId: 'bounty-intake-C-8', mode: 'observe', sample: 1, where: 'src/harness/reliability/workflow-guidance.ts:13', rule: 'contract-wrap', id: '4367202b' }); /* augur-inject:contract-wrap:4367202b */
// @ts-expect-error augur-inject
workflowGuidance = contract(workflowGuidance, { ...augurContract_831c01cb, contractId: 'HR-workflow-source', mode: 'observe', sample: 1, where: 'src/harness/reliability/workflow-guidance.ts:10', rule: 'contract-wrap', id: '831c01cb' }); /* augur-inject:contract-wrap:831c01cb */

const BOUNTY_DEFECT = /(?:バグ|不具合|壊れて|動かない|\bbugs?\b)/i;
const BOUNTY_DISCOVERY = /(?:見つけ|見付け|発見|\bfound\b)/i;
const BOUNTY_EXPLICIT = /(?:バウンティ|\bbounty\b|bug-bounty-report|(?<![\w/.-])\/bug\b(?![\w/.-]))/i;
const BOUNTY_REPORT_WISH = /(?:どこ(?:に|へ|で)|どうやって)[^。\n]{0,20}報告|報告(?:したい|できる|できます|できない|先|する(?:に|場所|方法))|\bwhere\b[^.\n]{0,30}\breport\b|\b(?:want|like|how) to report\b/i;
const BOUNTY_WORK_REQUEST = /(?:直して|直せ|修正して|修正を|実装して|実装を|\bfix\b|\bimplement\b)/i;
const BOUNTY_DECLINED = /報告(?:は|を)?(?:しない|しなくて|不要|いらない|要らない)/;

/**
 * バグバウンティの経路を案内する入力か (spec/feature/bug-bounty.md §8.1 §16.6)。
 *
 * 「報告」だけでは合図にしない (修正を頼んで結果の報告を求める入力は作業報告で、不具合の報告ではない)。
 * 案内するのは、報告先を尋ねる・報告を望む入力、不具合を見つけたと述べる入力、バウンティを名指しする入力。
 * 修正や実装の依頼では出さない (自分の作業で直すものは報告の対象ではない)。英語の bug は単語として取り、debug に当てない。
 */
function asksBugBountyRoute(text: string): boolean {
  if (BOUNTY_DECLINED.test(text)) return false;
  const defect = BOUNTY_DEFECT.test(text);
  if (defect && BOUNTY_REPORT_WISH.test(text)) return true;
  if (BOUNTY_WORK_REQUEST.test(text)) return false;
  return BOUNTY_EXPLICIT.test(text) || (defect && BOUNTY_DISCOVERY.test(text));
}

export function workflowContext(routes: readonly WorkflowGuidance[]): string {
  return routes.length ? "[Cc workflow assistance — routing only, no added authorization]\n" + routes.map((route) => route.advice).join("\n") : "";
}
