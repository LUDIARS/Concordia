import { buildDelegationContextTemplate } from "../delegation/persona-context.js";
import { buildImplementationInjectTemplate } from "../delegation/implementation-inject.js";
import { buildParttimerInjectTemplate } from "../delegation/parttimer-inject.js";
import {
  NORMAL_WORKFLOW_RULES, NORMAL_INTERRUPT_POLICY, NORMAL_COMPLETION_POLICY,
  ESCALATION_WORKFLOW_RULES, ESCALATION_INTERRUPT_POLICY, ESCALATION_COMPLETION_POLICY,
} from "./workflow-inject-defaults.js";

/** Fixed editing surface. No request-supplied identifier is ever used as a path. */
export interface MajorInjectDefinition {
  id: string;
  label: string;
  workflow: "session" | "delegation" | "rules";
  case: string;
  apply_scope: "next_startup_policy" | "next_session_start" | "next_delegation_launch" | "next_file_read";
  default_content: string;
  placeholders: readonly string[];
  required_placeholders: readonly string[];
  file_path?: string;
}

const DOMAIN_REPORT = "DDD を使った作業の成果報告では、実装が属する domain 名をコードブロックで強調し、価値 ID、specRefs、責務、実施/未実施検証を示してください。core でない支援境界を core と呼ばないでください。Pf 仕様と An の domain/関数 map は現行 registry/catalog で実体と URL を解決できたときだけリンクし、未登録・未確認ならそう明記して repo spec を示してください。URL を推測しないでください。";

export const MAJOR_INJECT_DEFINITIONS: readonly MajorInjectDefinition[] = [
  {
    id: "session.work_policy", label: "セッション作業方針", workflow: "session", case: "startup",
    apply_scope: "next_startup_policy", placeholders: [], required_placeholders: [],
    default_content: [
      "設計が固まったら、開始指示が未確認の実装は開始前に人間に確認してください。同じ範囲の開始指示をすでに受けている場合は、その根拠を確認して進め、重ねて確認しないでください。人間の指示と対応する Actio task を紐付け、task の状態を正本として進捗を追ってください。Cc の session work-phase は補助記録です。",
      "対象プロジェクトと実 checkout branch を確認し、Cc へ登録してください。branch 不一致など機械的な対象判定は Cc の警告に従ってください。",
      "Goal & Go は残作業を確認して継続してください。マージまで許可された依頼では、PR 提出や Test OK で止めず、PR の指摘修正・再審査・マージ・反映確認まで同じ loop で対応してください。停止時も進められる別作業を進め、1 loop の終わりに予定 task 一覧と進行中 GO を示してください。進められる作業が無ければ人間判断の要点を示して待機し、自動確認を繰り返さないでください。結果不明の提出・マージを再送せず、審査ゲートと明示された人間判断待ちを守ってください。",
      DOMAIN_REPORT,
    ].join("\n"),
  },
  {
    id: "session.process_guidance", label: "DDD・契約プロセス", workflow: "session", case: "startup",
    apply_scope: "next_startup_policy", placeholders: ["project_root", "steps"], required_placeholders: ["steps"],
    default_content: "[Cc DDD/契約プロセス] 必須設定が有効です。人間の指示に対応する Actio task と実装 domain を確認してください。\n[[CC:steps]]\n" + DOMAIN_REPORT,
  },
  {
    id: "session.process_guidance.value", label: "価値確認手順", workflow: "session", case: "startup",
    apply_scope: "next_startup_policy", placeholders: ["project_root"], required_placeholders: ["project_root"],
    default_content: "価値: [[CC:project_root]]/spec/ux/ の価値 ID・シナリオを選び、失うと困る利用者の状態を書く。無ければ先に spec/ux/product.md を書く。",
  },
  {
    id: "session.process_guidance.domain", label: "Domain所属手順", workflow: "session", case: "startup",
    apply_scope: "next_startup_policy", placeholders: ["project_root"], required_placeholders: ["project_root"],
    default_content: "所属: [[CC:project_root]]/spec/domains/*.domain.json の membership (pathPattern) と specRefs を確認する (anatomia where)。触るファイルが未宣言なら実装より前に宣言し、src と tests を対で載せる。状態所有者と不変条件を spec に残す。",
  },
  {
    id: "session.process_guidance.contract", label: "人間指示と契約", workflow: "session", case: "startup",
    apply_scope: "next_startup_policy", placeholders: [], required_placeholders: [],
    default_content: "契約: 人間の指示と対応する Actio task の目的・対象・変更内容・受入条件を確認する。人間の開始指示が無い実装は進めない。Cc の legacy work-phase は補助記録であり、task の実状態の正本ではない。",
  },
  {
    id: "session.process_guidance.implementation", label: "実装と受入対応", workflow: "session", case: "startup",
    apply_scope: "next_startup_policy", placeholders: ["project_root", "contract_clause"], required_placeholders: ["project_root", "contract_clause"],
    default_content: "実装: 業務判断は純関数、外部 I/O は adapter、手順は use case に分ける。テストを同じ変更単位で書き、[[CC:project_root]]/cc.acceptance.json の implementations に source / tests[[CC:contract_clause]] を対応付ける。",
  },
  {
    id: "session.process_guidance.validation", label: "検証手順", workflow: "session", case: "startup",
    apply_scope: "next_startup_policy", placeholders: [], required_placeholders: [],
    default_content: "検証: `git diff | anatomia verify` と登録テストの回帰。実行はユーザの許可範囲に従い、未実施はそのまま記録する。",
  },
  {
    id: "session.process_guidance.report", label: "提出とDomain報告", workflow: "session", case: "startup",
    apply_scope: "next_startup_policy", placeholders: [], required_placeholders: [],
    default_content: "提出: PR に価値 ID・不変条件・変更した境界・復旧方法・実施/未実施の検証を記す。" + DOMAIN_REPORT,
  },
  {
    id: "session.process_guidance.gate", label: "DDD所属ゲート案内", workflow: "session", case: "startup",
    apply_scope: "next_startup_policy", placeholders: ["project_root"], required_placeholders: ["project_root"],
    default_content: "編集ゲートは spec/ux が空、または specRefs 付きドメインの membership に一致しないファイルの編集を deny します。方針の正本: [[CC:project_root]]/spec/architecture/ddd.md (無ければ作成が先)。",
  },
  {
    id: "session.shared_startup_context", label: "共有資料案内", workflow: "session", case: "startup",
    apply_scope: "next_startup_policy", placeholders: ["castra_root", "resources", "selection_rule"], required_placeholders: ["castra_root", "resources"],
    default_content: "【新規起動時の最小共通コンテキスト】\nCastra root: [[CC:castra_root]]。cwd は現在のプロジェクトのまま、資料を絶対パスで読んでください。\n[[CC:selection_rule]]\n[[CC:resources]]",
  },
  {
    id: "session.workflow.normal", label: "通常協調ワークフロー", workflow: "session", case: "normal",
    apply_scope: "next_session_start", placeholders: [], required_placeholders: [],
    default_content: NORMAL_WORKFLOW_RULES.join("\n") + "\n" + DOMAIN_REPORT,
  },  {
    id: "session.workflow.escalation", label: "エスカレーション協調", workflow: "session", case: "escalation",
    apply_scope: "next_session_start", placeholders: ["reason","release_endpoint"], required_placeholders: ["reason","release_endpoint"],
    default_content: ESCALATION_WORKFLOW_RULES.join("\n") + "\n" + DOMAIN_REPORT,
  },  {
    id: "delegation.persona_context", label: "委託協調文脈", workflow: "delegation", case: "launch",
    apply_scope: "next_delegation_launch", placeholders: ["concordia_url","manual_block","command_pattern_block","team_rules_block","pr_base_clause","ask_marker_rule"], required_placeholders: ["concordia_url","manual_block","command_pattern_block","team_rules_block","pr_base_clause","ask_marker_rule"],
    default_content: buildDelegationContextTemplate() + "\n" + DOMAIN_REPORT,
  },  {
    id: "delegation.implementation_inject", label: "実装委託の進め方", workflow: "delegation", case: "implementation",
    apply_scope: "next_delegation_launch", placeholders: ["title","why","task","task_link_block","acceptance_block","status_endpoint","repo_block"], required_placeholders: ["title","why","task","task_link_block","acceptance_block","status_endpoint","repo_block"],
    default_content: buildImplementationInjectTemplate() + "\n" + DOMAIN_REPORT,
  },  {
    id: "delegation.parttimer_inject", label: "パートタイマーの進め方", workflow: "delegation", case: "parttimer",
    apply_scope: "next_delegation_launch", placeholders: ["title","task","concordia_url","cwd_block","manual_block","status_endpoint","mention_block"], required_placeholders: ["title","task","concordia_url","cwd_block","manual_block","status_endpoint","mention_block"],
    default_content: buildParttimerInjectTemplate() + "\n" + DOMAIN_REPORT,
  },
  {
    id: "session.workflow.normal.interrupt", label: "通常の割込み方針", workflow: "session", case: "normal",
    apply_scope: "next_session_start", placeholders: [], required_placeholders: [], default_content: NORMAL_INTERRUPT_POLICY,
  },
  {
    id: "session.workflow.normal.completion", label: "通常の完了方針", workflow: "session", case: "normal",
    apply_scope: "next_session_start", placeholders: [], required_placeholders: [], default_content: NORMAL_COMPLETION_POLICY.join("\n"),
  },
  {
    id: "session.workflow.escalation.interrupt", label: "エスカレーションの割込み方針", workflow: "session", case: "escalation",
    apply_scope: "next_session_start", placeholders: [], required_placeholders: [], default_content: ESCALATION_INTERRUPT_POLICY,
  },
  {
    id: "session.workflow.escalation.completion", label: "エスカレーションの完了方針", workflow: "session", case: "escalation",
    apply_scope: "next_session_start", placeholders: [], required_placeholders: [], default_content: ESCALATION_COMPLETION_POLICY.join("\n"),
  },
  {
    id: "session.process_guidance.implementation_basic", label: "実装手順（受入対応の必須設定なし）", workflow: "session", case: "startup",
    apply_scope: "next_startup_policy", placeholders: [], required_placeholders: [],
    default_content: "実装: 業務判断は純関数、外部 I/O は adapter、手順は use case に分ける。テストを同じ変更単位で書く。",
  },
];

export function majorInjectDefinition(id: string): MajorInjectDefinition | null {
  return MAJOR_INJECT_DEFINITIONS.find((source) => source.id === id) ?? null;
}

export function renderMajorInjectTemplate(
  content: string,
  values: Readonly<Record<string, string>>,
): string {
  return content.replace(/\[\[CC:([a-z_]+)\]\]/g, (_, name: string) => values[name] ?? "");
}

export function validateMajorInjectTemplate(definition: MajorInjectDefinition, content: string): {
  unknown: string[]; missing: string[];
} {
  const found = [...content.matchAll(/\[\[CC:([^\]]+)\]\]/g)].map((match) => match[1]);
  const unmatched = content.replace(/\[\[CC:[^\]]+\]\]/g, "").includes("[[CC:");
  return {
    unknown: [...new Set([
      ...found.filter((name) => !/^[a-z_]+$/.test(name) || !definition.placeholders.includes(name)),
      ...(unmatched ? ["malformed_token"] : []),
    ])],
    missing: definition.required_placeholders.filter((name) => !found.includes(name)),
  };
}
