/**
 * TB-ROOT-CMD: workspace root (global root, 例 `E:/Document/Ars`) 配下で実行するシェルコマンドは、
 * 作業境界 (登録 checkout / 作業対象 / 提出済み PR) とのずれだけを理由に止めない。
 *
 * LUDIARS は 1 つの root の下に多数のリポを並べ、セッションが横断して読む・調べる・ビルドする運用が多い。
 * 境界のずれによるコマンドの deny は、その運用で大半が誤停止になっていた (2026-11-17 neco 指示)。
 * ここでは「ずれ」系の rule の deny を warn へ下げるだけで、安全境界 (main 直 push・既知の地雷・
 * サービス起動・読み取り専用の問診/ユースケース・予算・受入条件・相談の情報保護など) は一切触らない。
 * 編集ツールは対象外 (登録外の checkout へ書き込む事故を防ぐ TB-REGISTERED を維持する)。
 *
 * @implements spec/feature/task-branch-harness.md TB-ROOT-CMD
 */
import { resolve } from "node:path";
import type { GateVerdict } from "../session-gate.js";
import type { Decision, PredicateHit } from "../predicates.js";

/** 作業境界のずれを表す rule。ここに無い rule (安全境界) は deny のまま残す。 */
export const WORKSPACE_ROOT_RELAXABLE_RULES: ReadonlySet<string> = new Set([
  "task-branch",
  "outside-scope",
  "max-repos",
  "submitted-task-boundary",
  "branch-before-edit",
]);

const COMMAND_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

const SEVERITY: Record<Decision, number> = { allow: 0, warn: 1, deny: 2 };

export const WORKSPACE_ROOT_RELAX_NOTE =
  "workspace root 配下のコマンドなので作業境界のずれでは止めません (TB-ROOT-CMD)。編集は登録した checkout で行ってください。";

function key(path: string): string {
  const normalized = resolve(path.trim()).replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

/** cwd が workspace root のどれかと同じか、その配下にあるか。空の root・空の cwd は一致しない。 */
export function isUnderWorkspaceRoot(cwd: string | undefined, roots: readonly string[]): boolean {
  if (!cwd?.trim()) return false;
  const target = key(cwd);
  return roots.some((root) => {
    if (!root.trim()) return false;
    const base = key(root);
    return target === base || target.startsWith(`${base}/`);
  });
}

/**
 * verdict の deny のうち、作業境界のずれ系だけを warn へ下げる。対象外なら同じ verdict をそのまま返す。
 * 下げた rule が 1 つでもあれば、decision・blocked・reason を残りの hit から組み直す。
 */
export function relaxWorkspaceRootCommand(
  verdict: GateVerdict,
  action: { tool: string; cwd?: string },
  roots: readonly string[],
): GateVerdict {
  if (!COMMAND_TOOLS.has(action.tool) || !isUnderWorkspaceRoot(action.cwd, roots)) return verdict;
  let relaxed = false;
  const hits: PredicateHit[] = verdict.hits.map((hit) => {
    if (hit.decision !== "deny" || !WORKSPACE_ROOT_RELAXABLE_RULES.has(hit.rule)) return hit;
    relaxed = true;
    return { ...hit, decision: "warn", reason: `${hit.reason} (${WORKSPACE_ROOT_RELAX_NOTE})` };
  });
  if (!relaxed) return verdict;
  let decision: Decision = "allow";
  for (const hit of hits) if (SEVERITY[hit.decision] > SEVERITY[decision]) decision = hit.decision;
  const reason = hits.map((hit) => `[${hit.rule}] ${hit.reason}${hit.suggestion ? ` → ${hit.suggestion}` : ""}`).join(" / ");
  return { ...verdict, decision, hits, blocked: decision === "deny", reason };
}
