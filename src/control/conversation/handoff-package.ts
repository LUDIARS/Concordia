/**
 * 交代時の引継ぎパッケージ (純関数)。
 *
 * 旧担当が保存し、後継の初回指示へ描画する。 Actio task 本文の第二正本は作らず、
 * task / run / 資料は参照と版で運ぶ。 保存前に clear / compact / 終了はしない。
 *
 * @implements spec/feature/astra-with-sidecar.md §コンパクションと設計コンテキスト
 */

export interface HandoffDecision {
  decision: string;
  reason: string;
}

export interface HandoffExternalOperation {
  /** 例: pr_submit / merge / delegation_invoke / deploy */
  kind: string;
  correlation_id: string;
  /** 確定 / 結果不明 / 未着手 */
  state: "confirmed" | "uncertain" | "not_started";
}

export interface HandoffPackage {
  summary: string;
  decisions: HandoffDecision[];
  repo_path: string;
  branch: string;
  /** 現行の成果・差分の参照 (commit / PR / ファイル)。 */
  outputs: string[];
  remaining: string[];
  /** 人間から許可されている範囲 (テスト・サービス操作・merge など)。 */
  authorization_scope: string;
  human_waits: string[];
  external_operations: HandoffExternalOperation[];
  task_references: string[];
  /** 必要資料の参照と版 (例: spec/feature/x.md@108b43bd)。 */
  references: string[];
}

export type HandoffPackageParse =
  | { ok: true; package: HandoffPackage }
  | { ok: false; issues: string[] };

const MAX_TEXT = 4000;
const MAX_LIST = 50;

export function parseHandoffPackage(value: unknown): HandoffPackageParse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, issues: ["package"] };
  const input = value as Record<string, unknown>;
  const issues: string[] = [];
  const text = (field: string): string => {
    const raw = input[field];
    if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_TEXT) {
      issues.push(field);
      return "";
    }
    return raw.trim();
  };
  const list = (field: string): string[] => {
    const raw = input[field];
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > MAX_LIST
      || raw.some((item) => typeof item !== "string" || item.length > MAX_TEXT)) {
      issues.push(field);
      return [];
    }
    return (raw as string[]).map((item) => item.trim()).filter(Boolean);
  };
  const decisions = Array.isArray(input.decisions) && input.decisions.length <= MAX_LIST
    ? input.decisions.flatMap((item): HandoffDecision[] => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      return typeof row.decision === "string" && row.decision.trim() && typeof row.reason === "string"
        ? [{ decision: row.decision.trim().slice(0, MAX_TEXT), reason: row.reason.trim().slice(0, MAX_TEXT) }]
        : [];
    })
    : [];
  if (input.decisions !== undefined && !Array.isArray(input.decisions)) issues.push("decisions");
  const operations = Array.isArray(input.external_operations) && input.external_operations.length <= MAX_LIST
    ? input.external_operations.flatMap((item): HandoffExternalOperation[] => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const state = row.state;
      if (typeof row.kind !== "string" || typeof row.correlation_id !== "string"
        || (state !== "confirmed" && state !== "uncertain" && state !== "not_started")) {
        issues.push("external_operations");
        return [];
      }
      return [{ kind: row.kind.slice(0, 120), correlation_id: row.correlation_id.slice(0, 200), state }];
    })
    : [];
  if (input.external_operations !== undefined && !Array.isArray(input.external_operations)) issues.push("external_operations");
  const pkg: HandoffPackage = {
    summary: text("summary"),
    decisions,
    repo_path: text("repo_path"),
    branch: text("branch"),
    outputs: list("outputs"),
    remaining: list("remaining"),
    authorization_scope: text("authorization_scope"),
    human_waits: list("human_waits"),
    external_operations: operations,
    task_references: list("task_references"),
    references: list("references"),
  };
  return issues.length ? { ok: false, issues: [...new Set(issues)] } : { ok: true, package: pkg };
}

/**
 * 保存しても交代させてはいけない内容か。 人間待ちと結果不明の外部操作は、切替で
 * 消えないよう旧担当に残す (MVP は自動交代を保留する)。
 */
export function packageHoldReasons(pkg: HandoffPackage): string[] {
  const reasons: string[] = [];
  if (pkg.human_waits.length) reasons.push(`人間待ち: ${pkg.human_waits.join(" / ")}`);
  const uncertain = pkg.external_operations.filter((op) => op.state === "uncertain");
  if (uncertain.length) reasons.push(`結果不明の外部操作: ${uncertain.map((op) => `${op.kind}(${op.correlation_id})`).join(", ")}`);
  return reasons;
}

/** 後継の初回指示。 */
export function renderHandoffBrief(input: {
  conversationId: string;
  handoffId: string;
  generation: number;
  pkg: HandoffPackage;
  nextInstruction: string;
}): string {
  const { pkg } = input;
  const bullets = (items: readonly string[]) => items.length ? items.map((item) => `- ${item}`).join("\n") : "- (なし)";
  return [
    "## 引継ぎ (Astra With Sidecar の実行セッション交代)",
    `会話: ${input.conversationId} / 世代: ${input.generation} / handoff: ${input.handoffId}`,
    "前任セッションが保存した引継ぎです。過去の会話を全て読み直す必要はありません。",
    "同じ Discord スレッドで人間と会話を続けてください。",
    "",
    "### 次の作業 (人間の指示)",
    input.nextInstruction || "(本文なし — 人間に次の作業内容を確認してください)",
    "",
    "### 要約",
    pkg.summary,
    "",
    "### 合意済みの決定と理由",
    pkg.decisions.length ? pkg.decisions.map((item) => `- ${item.decision} — ${item.reason}`).join("\n") : "- (なし)",
    "",
    `### 作業場所\n- repo: ${pkg.repo_path}\n- branch: ${pkg.branch}`,
    "",
    "### 現行の成果",
    bullets(pkg.outputs),
    "",
    "### 残件",
    bullets(pkg.remaining),
    "",
    `### 許可範囲\n${pkg.authorization_scope}`,
    "",
    "### task / 資料",
    bullets([...pkg.task_references, ...pkg.references]),
    "",
    "### 外部操作の相関 ID",
    pkg.external_operations.length
      ? pkg.external_operations.map((op) => `- ${op.kind}: ${op.correlation_id} (${op.state})`).join("\n")
      : "- (なし)",
  ].join("\n");
}
