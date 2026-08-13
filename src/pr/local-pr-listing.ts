/**
 * Revisor local PR 一覧の取得と描画 — `/rv-prs` コマンドと RWF 📋 の共有実体。
 *
 * 「PR」という言葉は GitHub PR と誤解されがちだが、 LUDIARS の実装レビューは
 * Revisor local PR (ローカルレビュー系) が正であり、 一覧を見る側にもそれを毎回
 * 明示的に教える (見出し + 注記)。 誤解の矯正は説明ページではなく、 実際に一覧を
 * 引いた瞬間の出力で行う。
 *
 * コマンドと RWF はこのモジュールに**結合**し、 Concordia 本体 (PR キュー /
 * bootstrap) からは reader の注入だけで**緩やかに分離**する — ここは Revisor の
 * 読み取り口 (`RevisorLocalPrReader`) 以外の Concordia 内部を知らない。
 *
 * @implements spec/tasks/2026-08-13-rv-prs-command-rwf.md
 */

import type { RevisorLocalPr, RevisorLocalPrReader } from "./revisor-client.js";
import { isOwnerRepo, normalizeRepoOrigin } from "./normalize.js";

export interface LocalPrListOptions {
  /** 指定時はそのリポジトリに絞る。 owner/repo / URL / SSH どの表記でも可。 */
  repository?: string | null;
  /** open PR の最大表示行数 (既定 15)。 超過分は件数だけ出す (無言切り詰め禁止)。 */
  limit?: number;
}

const DEFAULT_OPEN_LIMIT = 15;
const MERGED_RECENT_LIMIT = 5;
const REVISOR_REQUEST_FAILED = "revisor_request_failed";

/** checkStatus → 一目で分かる記号。 未知の状態は文字のまま出す (握り潰さない)。 */
const CHECK_STATUS_EMOJI: Record<string, string> = {
  action_required: "⚠️",
  failed: "❌",
  running: "🔄",
  queued: "⏳",
  test_ok: "✅",
};

/**
 * 「PR = Revisor local PR」を明示する定型注記。 一覧の頭に必ず付ける。
 * コマンド側・RWF 側の双方が同じ文言を出す (片方だけ教え損ねない)。
 */
export const REVISOR_PR_GUIDANCE =
  "LUDIARS で「PR」は原則この **Revisor local PR** (ローカルレビュー系) を指します。" +
  " GitHub PR のキューは別系統 (`/prs`)。";

function checkStatusMark(checkStatus: string): string {
  return CHECK_STATUS_EMOJI[checkStatus] ?? escapeInlineMarkdown(checkStatus);
}

/** Revisor / query 由来の値を Markdown の構造や platform mention にしない。 */
function escapeInlineMarkdown(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/@/g, "@\u200b")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+.!|~-])/g, "\\$1")
    .trim();
}

/** ローカルパスなど、一覧に出すべきでない repository 表記は伏せる。 */
function displayRepository(repository: string): string {
  const normalized = normalizeRepoOrigin(repository);
  return isOwnerRepo(normalized) ? escapeInlineMarkdown(normalized) : "(unknown repository)";
}

function describeLine(pr: RevisorLocalPr): string {
  const lane = pr.reviewLane === "fast" ? " / fast" : "";
  const title = pr.title?.trim() ? escapeInlineMarkdown(pr.title) : "(no title)";
  const headRef = pr.headRef?.trim() ? escapeInlineMarkdown(pr.headRef) : "(no branch)";
  const checkStatus = escapeInlineMarkdown(pr.checkStatus);
  return (
    `- ${checkStatusMark(pr.checkStatus)} #${pr.number} ${displayRepository(pr.repository)} ` +
    `${headRef} — ${title} (${checkStatus}${lane})`
  );
}

function matchesRepository(pr: RevisorLocalPr, repository: string): boolean {
  return normalizeRepoOrigin(pr.repository).toLowerCase() ===
    normalizeRepoOrigin(repository).toLowerCase();
}

/**
 * Revisor local PR 一覧を Markdown 1 枚に描画する。 open を checkStatus の緊急度順
 * (要対応 → 実行中 → 待機 → Test OK) に並べ、 直近 merged を末尾に少数添える。
 */
export function renderRevisorLocalPrListMarkdown(
  pullRequests: readonly RevisorLocalPr[],
  options: LocalPrListOptions = {},
): string {
  const repository = options.repository?.trim() || null;
  const scoped = repository
    ? pullRequests.filter((pr) => matchesRepository(pr, repository))
    : [...pullRequests];

  const open = scoped.filter((pr) => pr.status === "open");
  const mergedRecent = scoped
    .filter((pr) => pr.status === "merged")
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, MERGED_RECENT_LIMIT);

  // 要対応が埋もれると一覧の意味が無いので、 件数ではなく状態で並べる。
  const urgency = ["action_required", "failed", "running", "queued", "test_ok"];
  open.sort((a, b) => {
    const ua = urgency.indexOf(a.checkStatus);
    const ub = urgency.indexOf(b.checkStatus);
    if (ua !== ub) return (ua === -1 ? urgency.length : ua) - (ub === -1 ? urgency.length : ub);
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });

  const requestedLimit = options.limit;
  const limit = typeof requestedLimit === "number" && Number.isInteger(requestedLimit) && requestedLimit >= 0
    ? requestedLimit
    : DEFAULT_OPEN_LIMIT;
  const shown = open.slice(0, limit);
  const scopeLabel = repository ? ` — ${displayRepository(repository)}` : "";

  const lines: string[] = [
    `## Revisor local PR 一覧${scopeLabel}`,
    REVISOR_PR_GUIDANCE,
    "",
    `**open: ${open.length} 件**`,
  ];
  if (shown.length === 0) {
    lines.push("- open な local PR はありません");
  } else {
    lines.push(...shown.map(describeLine));
    if (open.length > shown.length) {
      lines.push(`- …他 ${open.length - shown.length} 件 (表示上限 ${limit} 件)`);
    }
  }
  if (mergedRecent.length > 0) {
    lines.push("", `**直近 merged (${mergedRecent.length} 件)**`);
    lines.push(...mergedRecent.map((pr) =>
      `- ✔ #${pr.number} ${displayRepository(pr.repository)} — ${
        pr.title?.trim() ? escapeInlineMarkdown(pr.title) : "(no title)"
      }`));
  }
  return lines.join("\n");
}

export interface LocalPrDigestResult {
  markdown: string;
  /** scope 適用後の open 件数。 呼び出し側のログ / 応答判定用。 */
  openCount: number;
  /** 取得に失敗した場合のみ。外部へ返してよい安定したエラーコード。 */
  error: string | null;
}

/**
 * reader から一覧を引いて Markdown にする。 Revisor 未構成・停止中でも例外にせず、
 * 「なぜ出ないか」を markdown として返す (無言スキップ禁止)。
 */
export async function buildRevisorLocalPrDigest(
  reader: Pick<RevisorLocalPrReader, "listLocalPrs"> | undefined,
  options: LocalPrListOptions = {},
): Promise<LocalPrDigestResult> {
  if (!reader) {
    return {
      markdown:
        "## Revisor local PR 一覧\n" +
        `${REVISOR_PR_GUIDANCE}\n\n` +
        "Revisor がこの構成では有効になっていません (reader 未注入)。",
      openCount: 0,
      error: "revisor_not_configured",
    };
  }
  try {
    const pullRequests = await reader.listLocalPrs();
    const markdown = renderRevisorLocalPrListMarkdown(pullRequests, options);
    const repository = options.repository?.trim() || null;
    const openCount = pullRequests.filter((pr) =>
      pr.status === "open" && (!repository || matchesRepository(pr, repository))).length;
    return { markdown, openCount, error: null };
  } catch {
    return {
      markdown:
        "## Revisor local PR 一覧\n" +
        `${REVISOR_PR_GUIDANCE}\n\n` +
        "Revisor から一覧を取得できませんでした。サービス状態を確認してください。",
      openCount: 0,
      error: REVISOR_REQUEST_FAILED,
    };
  }
}
