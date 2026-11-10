/**
 * リポ担当への依頼文 (repo-brief) の文面と解析 (純関数)。
 *
 * 依頼文は親自身に書かせる (実作業の文脈を持つのは親だけ)。 ここでは親への書き方の案内、
 * 親の発言からのブロック解析、 子へ渡す依頼文、 親への通知文を作る。
 *
 * @implements spec/feature/session-auto-succession.md §3.3, §3.4, §3.5 (INV-5)
 */

import type { ResolvedCheckout } from "./repo-agent-policy.js";

export const REPO_BRIEF_FENCE = "repo-brief";
const FENCE_PATTERN = /```repo-brief[^\S\r\n]*\r?\n([\s\S]*?)```/g;
const TITLE_MAX_CHARS = 60;
const EXCERPT_MAX_CHARS = 1500;

export interface RepoBrief {
  target: ResolvedCheckout;
  brief: string;
}

export interface RejectedRepoBrief {
  /** ブロックに書かれた checkout (読めなければ null)。 */
  checkout: string | null;
  reason: "invalid_json" | "unregistered_checkout" | "empty_brief";
}

export function hasRepoBriefFence(text: string): boolean {
  return text.includes("```repo-brief");
}

/** 親の発言から repo-brief ブロックを取り出す。 不正なブロックは理由付きで捨てる。 */
export function parseRepoBriefs(
  text: string,
  resolve: (path: string) => ResolvedCheckout | null,
): { briefs: RepoBrief[]; rejected: RejectedRepoBrief[] } {
  const briefs: RepoBrief[] = [];
  const rejected: RejectedRepoBrief[] = [];
  for (const match of text.matchAll(FENCE_PATTERN)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1] ?? "");
    } catch {
      rejected.push({ checkout: null, reason: "invalid_json" });
      continue;
    }
    const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    const checkout = typeof raw.checkout === "string" && raw.checkout.trim() ? raw.checkout.trim() : null;
    const brief = typeof raw.brief === "string" ? raw.brief.trim() : "";
    const target = checkout ? resolve(checkout) : null;
    if (!target) {
      rejected.push({ checkout, reason: "unregistered_checkout" });
      continue;
    }
    if (!brief) {
      rejected.push({ checkout, reason: "empty_brief" });
      continue;
    }
    briefs.push({ target, brief });
  }
  return { briefs, rejected };
}

/** ゲート deny 応答 / 副契機の inject に載せる、 依頼文の書き方。 */
export function buildBriefRequestText(checkout: string): string {
  return [
    "このリポは起動 cwd と違うため、このセッションからは編集できません。Cc がこの checkout",
    `(${checkout}) の担当エージェントを立てます。次の形式で依頼文を書いてください。`,
    "```repo-brief",
    JSON.stringify({ checkout, brief: "目的・変更内容・受入条件・関連ファイル/PR・許可範囲 (テスト・マージ)" }),
    "```",
  ].join("\n");
}

/** 副契機 (リポ分岐) で待機中の親へ送る案内。 */
export function buildBranchBriefRequestText(checkouts: readonly string[]): string {
  return [
    "【リポ担当の提案】このセッションは複数のリポを触っています。起動 cwd と違うリポの実装は、",
    "そのリポ (checkout) を cwd にした担当エージェントへ任せます。続けて任せるリポごとに依頼文を書いてください。",
    "任せないリポは書かなくて構いません (一定時間後に取り下げます)。",
    "",
    ...checkouts.map((checkout) => buildBriefRequestText(checkout).split("\n").slice(2).join("\n")),
  ].join("\n");
}

/** 同じ checkout に担当がいるとき (§3.5) の案内。 */
export function buildAlreadyAssignedText(checkout: string, childSessionId: string | null): string {
  if (!childSessionId) {
    return `この checkout (${checkout}) の担当エージェントは準備中です。依頼文がまだなら repo-brief ブロックで書いてください。`;
  }
  return [
    `この checkout (${checkout}) には担当 ${childSessionId} がいます。`,
    "追加の依頼は repo-brief ブロックか",
    `\`POST /v1/sessions/${childSessionId}/inject\` で渡してください。`,
  ].join("");
}

/** 子へ渡す依頼文。 先頭に担当であることと許可範囲の扱いを機械で付ける (§3.4 3)。 */
export function buildChildBriefText(input: {
  parentSessionId: string;
  checkout: string;
  projectCode: string | null;
  brief: string;
}): string {
  const project = input.projectCode ? `[${input.projectCode}] ` : "";
  return [
    `【リポ担当】あなたは親セッション ${input.parentSessionId} から ${project}${input.checkout} の実装を任された担当です。`,
    "許可範囲 (テスト・マージ等) は下の依頼文の記載に従い、記載が無ければ通常の作業規則に従ってください。",
    "完了・判断待ちは親セッションへ報告されます。",
    "",
    "## 依頼文 (親が記述)",
    input.brief,
  ].join("\n");
}

/** 子の追加依頼 (担当がいる checkout に repo-brief が来たとき)。 */
export function buildChildFollowupText(parentSessionId: string, brief: string): string {
  return [`【リポ担当への追加依頼】親セッション ${parentSessionId} から:`, "", brief].join("\n");
}

export function buildChildTitle(projectCode: string | null, brief: string): string {
  const firstLine = brief.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  const head = projectCode ? `[${projectCode}] ` : "";
  const title = `${head}${firstLine}`;
  return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1)}…` : title;
}

/** 担当が立ったことの親への通知 (§3.4 4)。 */
export function buildAssignedNoticeText(input: {
  childSessionId: string;
  checkout: string;
  projectCode: string | null;
  childThread: string | null;
}): string {
  const project = input.projectCode ? `[${input.projectCode}] ` : "";
  return [
    `【リポ担当を立てました】${project}${input.checkout} の担当は ${input.childSessionId} です。`,
    input.childThread ? `スレッド: ${input.childThread}` : null,
    "以後この checkout の実装は担当へ任せてください。",
    `追加の依頼は repo-brief ブロックか \`POST /v1/sessions/${input.childSessionId}/inject\` で渡せます。`,
  ].filter((line): line is string => line !== null).join("\n");
}

/** チャンネルへ出す 1 行 (担当が立った時・終わった時)。 */
export function buildAssignmentLine(input: {
  projectCode: string | null;
  checkout: string;
  childThread: string | null;
  childSessionId: string;
  ended: boolean;
}): string {
  const name = input.checkout.split("/").pop() ?? input.checkout;
  const project = input.projectCode ? `[${input.projectCode}] ` : "";
  const where = input.childThread ?? input.childSessionId;
  return `${input.ended ? "担当終了" : "担当"}: ${project}${name} → ${where}`;
}

/** 子の終了時に親へ届ける通知 (§3.4 5)。 */
export function buildChildEndedNoticeText(input: {
  childSessionId: string;
  checkout: string;
  lastMessage: string | null;
}): string {
  const prs = extractPrNumbers(input.lastMessage ?? "");
  const excerpt = (input.lastMessage ?? "").trim();
  const clipped = excerpt.length > EXCERPT_MAX_CHARS ? `${excerpt.slice(0, EXCERPT_MAX_CHARS)}…` : excerpt;
  return [
    `【リポ担当の終了】${input.checkout} の担当 ${input.childSessionId} が終了しました。`,
    prs.length ? `PR: ${prs.map((n) => `#${n}`).join(", ")}` : null,
    "",
    "## 担当の最後の発言 (抜粋)",
    clipped || "(発言を取得できませんでした。担当のチャンネルを確認してください)",
  ].filter((line): line is string => line !== null).join("\n");
}

/** 不正な repo-brief を捨てた理由を親へ返す文。 */
export function buildRejectedBriefText(rejected: readonly RejectedRepoBrief[]): string {
  const label: Record<RejectedRepoBrief["reason"], string> = {
    invalid_json: "JSON として読めません",
    unregistered_checkout: "checkout が Cc 登録プロジェクトに解決できません",
    empty_brief: "brief が空です",
  };
  return [
    "【repo-brief を受け付けられませんでした】",
    ...rejected.map((item) => `- ${item.checkout ?? "(checkout 不明)"}: ${label[item.reason]}`),
    "直して書き直してください。",
  ].join("\n");
}

export function extractPrNumbers(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/(?:\bPR\s*#?|\/pull\/)(\d{1,6})\b/gi)) found.add(Number(match[1]));
  return [...found];
}
