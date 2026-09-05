/**
 * GitHub `issues` イベントの正規化 (純関数)。
 *
 * webhook の payload とポーリングで引いた Issue を **同じ形** に均し、 発火するかどうかの
 * 判断材料だけを取り出す。 認可 (プロジェクト opt-in / 実行者) はここでは見ない
 * (authorization.ts) — ここは「何が起きたか」だけを言う。
 *
 * @implements spec/feature/github-issue-workflow.md — パイプライン
 */

/** 発火対象になり得る Issue 1 件。 */
export interface GithubIssueTrigger {
  repoOrigin: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  label: string;
  /** ラベルを付けた (= 依頼した) GitHub login。 */
  actor: string;
}

export type IssueEventClassification =
  | { kind: "trigger"; trigger: GithubIssueTrigger }
  | { kind: "ignored"; reason: "not_issue_event" | "other_action" | "label_absent" | "pull_request" | "malformed" };

/** ラベル付与とみなす action。 それ以外 (closed / edited / assigned…) は無視する。 */
const TRIGGERING_ACTIONS = new Set(["labeled", "opened", "reopened"]);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function labelNames(issue: Record<string, unknown>): string[] {
  const labels = issue.labels;
  if (!Array.isArray(labels)) return [];
  return labels
    .map((entry) => (typeof entry === "string" ? entry : text((entry as Record<string, unknown> | null)?.name)))
    .filter((name) => name !== "");
}

export function sameLabel(a: string, b: string): boolean {
  // GitHub のラベルは大小文字を区別して保存されるが、 運用の取り違え (cc / Cc) で
  // 黙って発火しないほうが事故なので、 照合は大小文字を無視する。
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * webhook payload を分類する。
 * @param label 設定された起動ラベル。
 */
export function classifyIssueEvent(input: {
  event: string | null | undefined;
  payload: unknown;
  label: string;
}): IssueEventClassification {
  if (input.event !== "issues") return { kind: "ignored", reason: "not_issue_event" };
  if (!input.payload || typeof input.payload !== "object") return { kind: "ignored", reason: "malformed" };
  const payload = input.payload as Record<string, unknown>;
  const action = text(payload.action);
  if (!TRIGGERING_ACTIONS.has(action)) return { kind: "ignored", reason: "other_action" };

  const issue = payload.issue;
  if (!issue || typeof issue !== "object") return { kind: "ignored", reason: "malformed" };
  const issueRow = issue as Record<string, unknown>;
  // Issue イベントには PR も混ざる (GitHub 上では PR も issue)。 PR に付いたラベルで
  // 実装セッションを起こさない。
  if (issueRow.pull_request) return { kind: "ignored", reason: "pull_request" };

  const number = issueRow.number;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const repoOrigin = text(repository?.full_name);
  if (typeof number !== "number" || !Number.isInteger(number) || repoOrigin === "") {
    return { kind: "ignored", reason: "malformed" };
  }

  // labeled は label フィールドが正本 (今まさに付いた 1 枚)。 opened / reopened は
  // 付与イベントが飛ばないので issue.labels を見る。
  const attached = action === "labeled"
    ? [text((payload.label as Record<string, unknown> | undefined)?.name)].filter((name) => name !== "")
    : labelNames(issueRow);
  const matched = attached.find((name) => sameLabel(name, input.label));
  if (!matched) return { kind: "ignored", reason: "label_absent" };

  // 実行者はイベントを起こした sender。opened でも issue.user を代用しない。特に
  // reopened で起票者を使うと、第三者による再開を trusted author の操作と誤認する。
  const actor = text((payload.sender as Record<string, unknown> | undefined)?.login);
  if (actor === "") return { kind: "ignored", reason: "malformed" };

  return {
    kind: "trigger",
    trigger: {
      repoOrigin,
      issueNumber: number,
      issueTitle: text(issueRow.title),
      issueBody: text(issueRow.body),
      issueUrl: text(issueRow.html_url),
      label: matched,
      actor,
    },
  };
}

/** ブランチ名。 Issue 番号を含めて 1 Issue 1 ブランチに固定する (再実行しても同じ)。 */
export function issueBranchName(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    // 非 ASCII のタイトル (日本語 Issue) は slug が空になる。 番号だけで一意なので許容する。
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug ? `cc-issue-${issueNumber}-${slug}` : `cc-issue-${issueNumber}`;
}
