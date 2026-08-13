/**
 * リアクションワークフローの PR 操作 (📋 一覧 / 📮 提出 / 🔀 マージ) の契約と結果文言。
 *
 * RWF エンジンは Concordia 内部 (Revisor クライアント / 社員名簿) を直接触らない。
 * ここで「セッション単位の PR 一覧・提出・マージ」を構造的なインタフェースとして宣言し、
 * 実体はホスト側 (`src/pr/session-pr-operations.ts`) が注入する。
 *
 * 文言をここに集約するのは **無言スキップを作らないため**。 一覧を出せなかった / 提出・
 * マージしなかった場合も、 押した人に「なぜそうなったか」がそのまま返る形にする。
 *
 * @implements spec/tasks/2026-08-08-rwf-pr-actions-and-panel-ui.md — RWF の PR 提出とマージ
 * @implements spec/tasks/2026-08-13-rv-prs-command-rwf.md — RWF の PR 一覧
 */

/** 操作対象になった Revisor local PR の最小情報 (応答文言に出す分だけ)。 */
export interface RwfLocalPrRef {
  id: string;
  number: number;
  repository: string;
  headRef: string;
}

/** 誰の操作かを記録するための実行者。 platform は注入時に束縛される。 */
export interface RwfPrActor {
  /** platform 上のユーザ ID (Discord / Slack)。 */
  userId: string;
}

const MAX_PR_LIST_RELAY_LENGTH = 1_750;
const PR_LIST_TRUNCATION_SUFFIX = "\n…(truncated)";

export type RwfPrSubmitOutcome =
  /** 新規提出 / 失敗していた PR の再提出。 */
  | { ok: true; kind: "submitted" | "resubmitted"; pullRequest: RwfLocalPrRef }
  /** 提出条件を満たさなかった (理由は必ず付く)。 */
  | { ok: false; kind: "skipped"; reason: string; detail?: string }
  /** 提出経路そのものが使えない (未注入 / セッション未特定)。 */
  | { ok: false; kind: "unavailable"; reason: string; detail?: string };

export type RwfPrMergeOutcome =
  | { ok: true; kind: "merged"; pullRequest: RwfLocalPrRef; authorizerRole: string | null }
  /** open な local PR が無い → 呼び出し側は従来の GitHub squash merge 経路へ落とす。 */
  | { ok: false; kind: "no_local_pr"; detail?: string }
  | { ok: false; kind: "not_authorized"; detail: string }
  | { ok: false; kind: "failed"; detail: string }
  /** マージ経路そのものが使えない (未注入 / セッション未特定)。 */
  | { ok: false; kind: "unavailable"; detail: string };

export type RwfPrListOutcome =
  /** 一覧を描画できた (markdown は共有 renderer が作る)。 */
  | { ok: true; markdown: string; openCount: number }
  /** 一覧経路そのものが使えない (未注入 / Revisor 未構成)。 */
  | { ok: false; kind: "unavailable"; detail: string; markdown?: string };

/**
 * セッション単位の PR 操作。 実体は `POST /v1/prs/local` と同じ提出関数と、
 * PR #297 が切り出した指示者ベースの認可付きマージを使う (ロジックを複製しない)。
 */
export interface RwfPrOperations {
  submitLocalPr(input: { sessionId: string; actor: RwfPrActor }): Promise<RwfPrSubmitOutcome>;
  mergeLocalPr(input: { sessionId: string; actor: RwfPrActor }): Promise<RwfPrMergeOutcome>;
  /**
   * 📋 Revisor local PR 一覧。 セッションチャンネルならそのリポジトリに絞り、
   * それ以外は全件を返す。 読み取り専用なので権限は要らない。 optional なのは
   * 既存の注入実装 (テスト含む) を一斉に壊さないため — 未実装は unavailable 扱い。
   */
  listLocalPrs?(input: { sessionId: string | null; actor: RwfPrActor }): Promise<RwfPrListOutcome>;
}

/**
 * 提出を見送った理由の日本語訳。 `SkipReason` (src/pr/local-pr-submission.ts) と
 * セッション解決の失敗理由を両方受ける。 未知の理由もそのまま出す (握り潰さない)。
 */
const SUBMIT_REASON_TEXT: Record<string, string> = {
  no_branch: "セッションに作業ブランチが記録されていません",
  on_base_branch: "作業ブランチが base ブランチ (main 等) のままです",
  repository_not_registered: "このリポジトリが Revisor に登録されていません",
  no_commits: "base から進んだコミットがありません",
  already_open: "同じブランチの local PR が既に open です",
  session_not_found: "対象セッションが Concordia に見つかりません",
  no_session: "リアクション先がセッションチャンネルではないため、対象セッションを特定できません",
  operations_unavailable: "PR 提出経路がこの構成では有効になっていません",
  error: "Revisor への提出中にエラーが発生しました",
};

export function describeSubmitSkipReason(reason: string): string {
  return SUBMIT_REASON_TEXT[reason] ?? `提出できませんでした (${reason})`;
}

function describePr(pr: RwfLocalPrRef): string {
  return `local PR #${pr.number} (${pr.repository} / \`${pr.headRef}\`)`;
}

/** 📮 の結果文言。 提出できなかった場合も必ず理由を書く。 */
export function describePrSubmitOutcome(outcome: RwfPrSubmitOutcome, actor: RwfPrActor): string {
  const by = `実行者: <@${actor.userId}>`;
  if (outcome.ok) {
    const verb = outcome.kind === "submitted" ? "提出しました" : "再提出しました";
    return `${describePr(outcome.pullRequest)} を Revisor へ${verb}。\n${by}`;
  }
  const reason = describeSubmitSkipReason(outcome.reason);
  const detail = outcome.detail ? `\n詳細: ${outcome.detail}` : "";
  return `PR を提出しませんでした — ${reason}。${detail}\n${by}`;
}

/** 📋 の結果文言。 一覧が出せなかった場合も必ず理由を書く。 */
export function describePrListOutcome(outcome: RwfPrListOutcome, actor: RwfPrActor): string {
  const by = `実行者: <@${actor.userId}>`;
  if (!outcome.ok && !outcome.markdown) {
    return `Revisor local PR 一覧を出せませんでした — ${outcome.detail}\n${by}`;
  }
  const rendered = outcome.markdown ?? "";
  const suffix = `\n${by}`;
  const maxMarkdownLength = Math.max(0, MAX_PR_LIST_RELAY_LENGTH - suffix.length);
  const markdown = rendered.length <= maxMarkdownLength
    ? rendered
    : `${rendered
      .slice(0, Math.max(0, maxMarkdownLength - PR_LIST_TRUNCATION_SUFFIX.length))
      .trimEnd()}${PR_LIST_TRUNCATION_SUFFIX}`;
  return `${markdown}${suffix}`;
}

/** 🔀 で Revisor local PR を実際にマージしたときの文言 (どちらの経路かを明記する)。 */
export function describePrMergeOutcome(outcome: RwfPrMergeOutcome, actor: RwfPrActor): string {
  const by = `実行者: <@${actor.userId}>`;
  switch (outcome.kind) {
    case "merged": {
      const role = outcome.authorizerRole ? ` / 役職: ${outcome.authorizerRole}` : "";
      return `Revisor local PR をマージしました — ${describePr(outcome.pullRequest)}。\n${by}${role}`;
    }
    case "not_authorized":
      return `マージしませんでした — ${outcome.detail}\n${by}`;
    case "failed":
      return `Revisor local PR のマージに失敗しました — ${outcome.detail}\n${by}`;
    case "no_local_pr":
    case "unavailable":
      // 「代わりに何を実行するか」は経路を決める側 (RWF) が describeMergeFallback で書く。
      // ここは対象が無かったという事実だけを述べる (操作パネルからは何も代行しない)。
      return `マージ対象の Revisor local PR がありません — ${outcome.detail ?? "open な local PR が見つかりません"}。\n${by}`;
  }
}

/**
 * local PR が無い / 経路が無いときに GitHub squash merge へ落とす旨の文言。
 * 「どちらを実行したか」を必ず本人に返すためのもの (無言フォールバック禁止)。
 */
export function describeMergeFallback(
  outcome: Extract<RwfPrMergeOutcome, { kind: "no_local_pr" | "unavailable" }>,
): string {
  const why = outcome.kind === "no_local_pr"
    ? outcome.detail ?? "このセッションが提出した open な Revisor local PR がありません"
    : outcome.detail;
  return `Revisor local PR ではなく **GitHub PR の squash merge 経路**を実行します — ${why}。`;
}
