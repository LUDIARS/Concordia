/**
 * Melpomene のバグ報告 (契約 v1 §4a Hub 側)。
 *
 * - HTTP `POST /v1/glab-unity/melpomene/reports` の本文は ≤ 5 MiB (gzip なら展開後)。
 * - repo は設定の許可リスト (`glabUnityHub.melpomeneRepos`) にあるものだけ。
 * - ログは Discord のバグ報告チャンネルへ添付で上げ、 そのリンクを Issue 本文に書く。
 * - WS の `melpomene.report` はログ無し・本文のみ。
 *
 * GitHub のトークンは Unity に持たせない (Hub 側の gh 認証で起票する)。
 *
 * @implements spec/feature/glab-unity-hub.md §4a (GUH-MELPOMENE)
 */

import { z } from "zod";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:4a45a428 */
import augurContract_ce6e9f5b from './melpomene-repo.contract.js'; /* augur-inject:contract-predicate:c7d78a31 */

export const MAX_REPORT_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_REPORT_LOGS = 8;
/** Discord の添付 1 件の安全側の上限。 */
export const MAX_LOG_FILE_BYTES = 8 * 1024 * 1024;

const LOG_NAME_RE = /^[A-Za-z0-9._ -]{1,100}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LABEL_RE = /^[^\u0000-\u001f,]{1,50}$/u;

export const MelpomeneReportSchema = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(60_000),
  category: z.string().trim().max(64).optional(),
  priority: z.string().trim().max(32).optional(),
  labels: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
  repo: z.string().trim().regex(REPO_RE),
  logs: z.array(z.object({
    name: z.string().regex(LOG_NAME_RE),
    contentBase64: z.string().max(MAX_REPORT_BODY_BYTES),
  }).strict()).max(MAX_REPORT_LOGS).optional(),
}).strict();

export type MelpomeneReport = z.infer<typeof MelpomeneReportSchema>;

export interface DecodedLog {
  readonly name: string;
  readonly content: Buffer;
}

export type ReportCheck =
  | { readonly ok: true; readonly report: MelpomeneReport; readonly logs: readonly DecodedLog[] }
  | { readonly ok: false; readonly code: "invalid_request" | "forbidden"; readonly message: string };

/** 大文字小文字を無視して許可リストと突き合わせる。 */
export function isAllowedRepo(repo: string, allowed: readonly string[]): boolean {
  const wanted = repo.trim().toLowerCase();
  return allowed.some((entry) => entry.trim().toLowerCase() === wanted);
}

/** 報告 1 件を検査し、 ログを展開する。 */
export function checkReport(value: unknown, allowedRepos: readonly string[]): ReportCheck {
  const parsed = MelpomeneReportSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, code: "invalid_request", message: `${first?.path.join(".") || "body"}: ${first?.message ?? "invalid"}` };
  }
  if (!isAllowedRepo(parsed.data.repo, allowedRepos)) {
    return { ok: false, code: "forbidden", message: "repo is not in glabUnityHub.melpomeneRepos" };
  }
  const logs: DecodedLog[] = [];
  for (const log of parsed.data.logs ?? []) {
    if (!/^[A-Za-z0-9+/=\s]*$/.test(log.contentBase64)) {
      return { ok: false, code: "invalid_request", message: `logs.${log.name}: contentBase64 is not base64` };
    }
    const content = Buffer.from(log.contentBase64, "base64");
    if (content.length > MAX_LOG_FILE_BYTES) {
      return { ok: false, code: "invalid_request", message: `logs.${log.name}: too large` };
    }
    logs.push({ name: log.name, content });
  }
  return { ok: true, report: parsed.data, logs };
}

/** gh に渡してよいラベルだけ残す (区切り文字や制御文字を含むものは落とす)。 */
export function safeLabels(labels: readonly string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((label) => label.trim()).filter((label) => LABEL_RE.test(label)))];
}

/** Issue 本文。 報告者は Discord 表示名 (Unity から)、 ログは添付リンクを列挙する。 */
export function composeIssueBody(input: {
  readonly report: Pick<MelpomeneReport, "body" | "category" | "priority">;
  readonly reporterName: string;
  readonly reporterDiscordUserId: string;
  readonly logUrls: readonly { readonly name: string; readonly url: string }[];
}): string {
  const lines = [input.report.body.trim() || "(本文なし)", "", "---", "", "| 項目 | 値 |", "| --- | --- |"];
  lines.push(`| 報告者 | ${escapeCell(input.reporterName)} (Unity, Discord ${input.reporterDiscordUserId}) |`);
  if (input.report.category) lines.push(`| 分類 | ${escapeCell(input.report.category)} |`);
  if (input.report.priority) lines.push(`| 優先度 | ${escapeCell(input.report.priority)} |`);
  lines.push("| 送信元 | GLab-UnityHub (Melpomene) |");
  if (input.logUrls.length > 0) {
    lines.push("", "### ログ", "");
    for (const log of input.logUrls) lines.push(`- [${log.name}](${log.url})`);
  }
  return lines.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
// @ts-expect-error augur-inject
checkReport = contract(checkReport, { ...augurContract_ce6e9f5b, contractId: 'guh-C-7', mode: 'observe', sample: 1, where: 'src/glab-unity-hub/domain/melpomene-report.ts:58', rule: 'contract-wrap', id: 'ce6e9f5b' }); /* augur-inject:contract-wrap:ce6e9f5b */
