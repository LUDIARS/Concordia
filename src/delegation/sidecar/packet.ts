/**
 * Sidecar (Sol) へ渡す委任パケット。
 *
 * 親が決めた範囲・受入条件・禁止事項を版付きで固定し、子の初回指示へ短く描画する。
 * 秘密や無関係な会話は複製しない — パケットは参照 (task / 設計版 / 許可根拠) を運び、
 * 本文の第二正本を作らない。 権限は本文ではなく操作時に現行正本で照合する。
 *
 * @implements spec/feature/astra-with-sidecar.md §モデル選択と委任契約
 */

export interface SidecarBudget {
  /** 子 1 回あたりの上限 (分)。 */
  max_minutes?: number;
  /** 子 1 回あたりの概算上限 (provider の credit / token 単位の表示値)。 */
  max_cost?: number;
}

export interface SidecarPacket {
  /** Actio task 参照 (actio:<uuid> または spec/tasks/*.md)。 */
  task_reference: string;
  /** 依頼の版。 範囲や受入条件が変わったら上げる。 */
  request_version: number;
  /** 許可の根拠 (人間の指示 ID やメッセージ参照)。 本文ではなく参照を運ぶ。 */
  authorization_ref: string;
  repo_path: string;
  origin: string;
  /** 子 worktree の起点 commit。 親の作業 branch の commit を渡すと子もそこから始まる。 */
  base_commit: string;
  /** 編集してよい範囲 (repo 相対のパス / glob)。 */
  editable_paths: string[];
  /** 子が作業する branch。 親の branch と同じ名前は使えない。 */
  child_branch: string;
  objective: string;
  design_refs: string[];
  acceptance: string[];
  forbidden: string[];
  open_questions: string[];
  /** 子に許すテスト・検証の範囲。 人間の許可範囲を超えない。 */
  verification: string;
  /** どこまでで完了とするか (例: "commit + local PR 提出まで")。 */
  completion_scope: string;
  budget?: SidecarBudget;
  /** 返却形式への追加指示。 既定の返却項目は SIDECAR_RETURN_FIELDS。 */
  return_format?: string;
}

export const SIDECAR_RETURN_FIELDS = [
  "summary",
  "commits",
  "verification_done",
  "verification_skipped",
  "remaining",
  "consumption",
  "failure_reason",
] as const;

export type PacketIssue = { field: string; problem: "missing" | "invalid" | "too_long" | "secret_like" };

export type PacketParse =
  | { ok: true; packet: SidecarPacket }
  | { ok: false; issues: PacketIssue[] };

const MAX_TEXT = 4000;
const MAX_LIST = 40;
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** パケットに秘密を複製させない。 鍵らしい値だけを弾く (誤検知時は参照に置き換えればよい)。 */
const SECRET_RE = /(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})/;

/** JSON 由来の値をパケットへ検証付きで変換する。 不足・不正はまとめて返す。 */
export function parseSidecarPacket(value: unknown): PacketParse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, issues: [{ field: "sidecar_packet", problem: "missing" }] };
  }
  const input = value as Record<string, unknown>;
  const issues: PacketIssue[] = [];
  const text = (field: string, required = true): string => {
    const raw = input[field];
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
      if (required) issues.push({ field, problem: "missing" });
      return "";
    }
    if (typeof raw !== "string") {
      issues.push({ field, problem: "invalid" });
      return "";
    }
    if (raw.length > MAX_TEXT) issues.push({ field, problem: "too_long" });
    return raw.trim();
  };
  const list = (field: string, required: boolean): string[] => {
    const raw = input[field];
    if (raw === undefined || raw === null) {
      if (required) issues.push({ field, problem: "missing" });
      return [];
    }
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
      issues.push({ field, problem: "invalid" });
      return [];
    }
    const items = (raw as string[]).map((item) => item.trim()).filter(Boolean);
    if (required && items.length === 0) issues.push({ field, problem: "missing" });
    if (items.length > MAX_LIST || items.some((item) => item.length > MAX_TEXT)) {
      issues.push({ field, problem: "too_long" });
    }
    return items;
  };

  const requestVersion = input.request_version;
  if (typeof requestVersion !== "number" || !Number.isInteger(requestVersion) || requestVersion < 1) {
    issues.push({ field: "request_version", problem: requestVersion === undefined ? "missing" : "invalid" });
  }
  const packet: SidecarPacket = {
    task_reference: text("task_reference"),
    request_version: typeof requestVersion === "number" ? requestVersion : 0,
    authorization_ref: text("authorization_ref"),
    repo_path: text("repo_path"),
    origin: text("origin"),
    base_commit: text("base_commit"),
    editable_paths: list("editable_paths", true),
    child_branch: text("child_branch"),
    objective: text("objective"),
    design_refs: list("design_refs", false),
    acceptance: list("acceptance", true),
    forbidden: list("forbidden", false),
    open_questions: list("open_questions", false),
    verification: text("verification"),
    completion_scope: text("completion_scope"),
  };
  const returnFormat = text("return_format", false);
  if (returnFormat) packet.return_format = returnFormat;
  const budget = parseBudget(input.budget, issues);
  if (budget) packet.budget = budget;

  if (packet.base_commit && !COMMIT_RE.test(packet.base_commit)) {
    issues.push({ field: "base_commit", problem: "invalid" });
  }
  if (packet.child_branch && (!BRANCH_RE.test(packet.child_branch) || packet.child_branch.includes(".."))) {
    issues.push({ field: "child_branch", problem: "invalid" });
  }
  if (packet.child_branch === "main" || packet.child_branch === "master") {
    issues.push({ field: "child_branch", problem: "invalid" });
  }
  if (SECRET_RE.test(JSON.stringify(input))) {
    issues.push({ field: "sidecar_packet", problem: "secret_like" });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, packet };
}

function parseBudget(value: unknown, issues: PacketIssue[]): SidecarBudget | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    issues.push({ field: "budget", problem: "invalid" });
    return null;
  }
  const raw = value as Record<string, unknown>;
  const budget: SidecarBudget = {};
  for (const key of ["max_minutes", "max_cost"] as const) {
    const item = raw[key];
    if (item === undefined) continue;
    if (typeof item !== "number" || !Number.isFinite(item) || item <= 0) {
      issues.push({ field: `budget.${key}`, problem: "invalid" });
      continue;
    }
    budget[key] = item;
  }
  return budget;
}

/** 同じ依頼を識別するキー。 再委任の回数上限はこの単位で数える。 */
export function sidecarRequestKey(packet: Pick<SidecarPacket, "task_reference" | "request_version">): string {
  return `${packet.task_reference}#v${packet.request_version}`;
}

/**
 * 子の初回指示に載せる本文。 静的な規則を先に、可変の依頼を後に置く
 * (同一モデル・互換リクエストで共通 prefix が一致した場合だけキャッシュが効きうるため)。
 */
export function renderSidecarPacket(packet: SidecarPacket): string {
  const bullets = (items: readonly string[]) => items.length ? items.map((item) => `- ${item}`).join("\n") : "- (なし)";
  const lines = [
    "## Sidecar 委任契約 (Astra With Sidecar)",
    "",
    "あなたは Astra 親から、範囲の定まった作業を受けた Sidecar です。",
    "- 編集してよいのは「編集範囲」だけです。範囲外の変更が必要になったら作業を止め、親へ理由を返してください。",
    "- 要件や受入条件が曖昧なら推測で埋めず、未解決として親へ返してください。",
    "- 許可されていない検証・サービス操作・merge は行わないでください。",
    "- 完了は下記「完了範囲」までです。完了報告には返却項目をすべて含めてください。",
    "",
    "### 返却項目",
    ...SIDECAR_RETURN_FIELDS.map((field) => `- ${field}`),
    "",
    "## 依頼",
    `- task: ${packet.task_reference} (依頼版 v${packet.request_version})`,
    `- 許可根拠: ${packet.authorization_ref}`,
    `- repo: ${packet.repo_path} (${packet.origin})`,
    `- 起点 commit: ${packet.base_commit}`,
    `- 作業 branch: ${packet.child_branch}`,
    "",
    "### 目的",
    packet.objective,
    "",
    "### 編集範囲",
    bullets(packet.editable_paths),
    "",
    "### 受入条件",
    bullets(packet.acceptance),
    "",
    "### 禁止事項",
    bullets(packet.forbidden),
    "",
    "### 設計・参照",
    bullets(packet.design_refs),
    "",
    "### 未決事項",
    bullets(packet.open_questions),
    "",
    `### 検証の許可\n${packet.verification}`,
    "",
    `### 完了範囲\n${packet.completion_scope}`,
  ];
  if (packet.budget) {
    const parts = [
      packet.budget.max_minutes ? `${packet.budget.max_minutes} 分` : null,
      packet.budget.max_cost ? `概算 ${packet.budget.max_cost}` : null,
    ].filter(Boolean);
    if (parts.length) lines.push("", `### 予算\n${parts.join(" / ")} を超えそうなら途中で止めて親へ返してください。`);
  }
  if (packet.return_format) lines.push("", `### 返却形式の追加指示\n${packet.return_format}`);
  return lines.join("\n");
}
