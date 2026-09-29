/**
 * プロジェクト登録後に、そのプロジェクトの実装ポリシー / ルールの本文をセッションへ届ける
 * (2026-09-29 neco 指示)。 起動案内 (startup policy) は資料のパスしか伝えないため、読み落としが起きる。
 *
 * - 対象: 登録が確定したプロジェクトと、セッションが触った別リポ (`active_repos`) のプロジェクト。
 *   複数プロジェクトになったら、新しく加わったものごとに届ける。
 * - 資料: プロジェクトが正本として持つ AGENTS.md (無ければ CLAUDE.md) と rule/README.md。
 *   長さに上限を設け、切り詰めたら正本のパスを添える。 読めない資料は不足として明示する。
 * - 重複: 届けた内容のハッシュをセッション metadata に残し、同じ内容は再送しない。
 *   内容が変わったら届け直す。
 *
 * @implements spec/feature/project-rules-inject.md
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

export const PROJECT_RULES_METADATA_KEY = "cc_project_rules_delivered";
export const PROJECT_RULES_INJECT_SOURCE = "cc-project-rules";

/** 1 資料あたりの上限 (文字)。 超えた分は正本のパスを案内する。 */
export const PROJECT_RULES_MAX_CHARS = 6_000;

export interface ProjectRulesTarget {
  code: string;
  root: string;
}

export interface ProjectRulesDocument {
  label: string;
  path: string | null;
  text: string | null;
  truncated: boolean;
}

export interface ProjectRulesBundle extends ProjectRulesTarget {
  documents: ProjectRulesDocument[];
  hash: string;
}

type ReadText = (path: string) => Promise<string | null>;

const SOURCES: Array<{ label: string; candidates: (root: string) => string[] }> = [
  { label: "作業規則", candidates: (root) => [join(root, "AGENTS.md"), join(root, "CLAUDE.md")] },
  { label: "rule 索引", candidates: (root) => [join(root, "rule", "README.md")] },
];

export async function collectProjectRules(target: ProjectRulesTarget, readText: ReadText): Promise<ProjectRulesBundle> {
  const documents: ProjectRulesDocument[] = [];
  for (const source of SOURCES) {
    let found: ProjectRulesDocument = { label: source.label, path: null, text: null, truncated: false };
    for (const path of source.candidates(target.root)) {
      const raw = await readText(path).catch(() => null);
      if (raw === null || !raw.trim()) continue;
      const trimmed = raw.trim();
      found = {
        label: source.label,
        path,
        text: trimmed.length > PROJECT_RULES_MAX_CHARS ? trimmed.slice(0, PROJECT_RULES_MAX_CHARS) : trimmed,
        truncated: trimmed.length > PROJECT_RULES_MAX_CHARS,
      };
      break;
    }
    documents.push(found);
  }
  const hash = createHash("sha256")
    .update(JSON.stringify(documents.map((doc) => [doc.label, doc.path, doc.text, doc.truncated])))
    .digest("hex");
  return { ...target, documents, hash };
}

/** 届けていない、または内容が変わったプロジェクトだけを返す。 */
export function selectUndelivered(
  bundles: readonly ProjectRulesBundle[],
  delivered: Readonly<Record<string, string>>,
): ProjectRulesBundle[] {
  return bundles.filter((bundle) => delivered[bundle.code] !== bundle.hash);
}

export function buildProjectRulesText(bundle: ProjectRulesBundle, reason: "registered" | "updated"): string {
  const lines = [
    `[Cc project rules] ${bundle.code} (${bundle.root})`,
    reason === "registered"
      ? "このセッションの作業対象にこのプロジェクトが加わりました。以下はプロジェクトが正本として持つ実装ポリシー / ルールです。作業前に従ってください。"
      : "このプロジェクトのルール資料が更新されました。以下が現在の内容です。",
    "資料の読み込みは実行許可を追加しません。テスト・起動・merge の範囲は人間の指示に従ってください。",
  ];
  for (const doc of bundle.documents) {
    lines.push("", `## ${doc.label}${doc.path ? ` — ${doc.path}` : ""}`);
    if (!doc.text) {
      lines.push("(見つかりません。資料の有無をプロジェクトで確認してください。読了したと扱わないでください)");
      continue;
    }
    lines.push(doc.text);
    if (doc.truncated) lines.push("", `(${PROJECT_RULES_MAX_CHARS} 文字で切り詰めました。続きは正本 ${doc.path} を読んでください)`);
  }
  return lines.join("\n");
}

export function readDeliveredProjectRules(metadata: string | null): Record<string, string> {
  try {
    const value = (JSON.parse(metadata ?? "{}") as Record<string, unknown>)[PROJECT_RULES_METADATA_KEY];
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}
