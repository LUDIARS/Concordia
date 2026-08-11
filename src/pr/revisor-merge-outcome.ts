/**
 * Revisor local PR マージの失敗を「呼び出し側が行動を決められる理由」へ落とす。
 *
 * 元の実装は失敗を一律 `local_pr_merge_failed` に潰していた。 理由を伏せたのは
 * Revisor の生メッセージが endpoint やローカルパスを含み得るからで、 その判断自体は
 * 正しい。 潰しすぎていたのが問題で、 2026-08-10 には **既にマージ済みの PR** への
 * マージ要求が「マージできない」と読めてしまい、 実状態を DB から直接読むまで
 * 誤診断が続いた。
 *
 * ここでは分類を行動が変わる単位の enum に落とす (再 rebase が要る / もう終わっている / 等)。
 * Revisor の原文は未知の機密情報を含み得るため、分類済みの場合にも API 応答や
 * Concordia のログへは返さない。診断には status・分類・Revisor 側ログを使う。
 */

/** 呼び出し側の次の行動が変わる単位。 */
export type RevisorMergeFailureReason =
  /** 対象 PR が既にマージ済み。 失敗ではなく、要求が遅れて届いただけ。 */
  | "already_merged"
  /** open ではない (closed 等)。 マージ対象になり得ない。 */
  | "not_open"
  /** main と競合。 rebase して出し直す。 */
  | "conflict"
  /** 審査ゲートが通っていない。 通してから再要求する。 */
  | "gate_not_passed"
  /** 認可されなかった (token 不正 / 権限不足)。 */
  | "unauthorized"
  /** Revisor に到達できない。 */
  | "unreachable"
  /** 応答が返る前に打ち切った。 Revisor 側は続行している可能性がある。 */
  | "timeout"
  /** 上記に当てはまらない。管理者が upstream 状態を確認する。 */
  | "unknown";

export interface RevisorMergeFailure {
  reason: RevisorMergeFailureReason;
  /** 呼び出し側へ返してよい文面 (パス / URL を含まない)。 */
  detail: string;
}

export interface RevisorMergeErrorOptions {
  /** Revisor が返した HTTP status。 到達しなかった場合は null。 */
  status?: number | null;
  /** Revisor の `error` フィールド原文。 分類専用で、応答やログへ出さない。 */
  revisorError?: string | null;
  /** タイムアウトで打ち切ったか。 */
  timedOut?: boolean;
}

/**
 * マージ経路の失敗。 分類に必要な素材 (status / 原文 / 打ち切りか) を保持する。
 * `message` は開発者向けで、 API 応答には使わない。
 */
export class RevisorMergeError extends Error {
  readonly status: number | null;
  readonly timedOut: boolean;
  #revisorError: string | null;

  constructor(message: string, options: RevisorMergeErrorOptions = {}) {
    super(message);
    this.name = "RevisorMergeError";
    this.status = options.status ?? null;
    this.#revisorError = options.revisorError ?? null;
    this.timedOut = options.timedOut === true;
  }

  /** 分類器だけが明示的に読む。private field なので Error の構造化ログへ列挙されない。 */
  get revisorError(): string | null {
    return this.#revisorError;
  }
}

/** 原文に含まれる語から理由を決める。 status だけでは open/conflict を区別できない。 */
function reasonFromText(text: string): RevisorMergeFailureReason | null {
  const lower = text.toLowerCase();
  if (lower.includes("already merged") || lower.includes("has already been merged")) return "already_merged";
  if (lower.includes("conflict")) return "conflict";
  if (lower.includes("rebase")) return "conflict";
  if (lower.includes("not open") || lower.includes("closed")) return "not_open";
  if (
    lower.includes("test_ok")
    || lower.includes("gate")
    || lower.includes("check status")
    || lower.includes("required check")
    || lower.includes("checks have not")
  ) return "gate_not_passed";
  return null;
}

const DETAIL: Record<RevisorMergeFailureReason, string> = {
  already_merged: "対象の local PR は既にマージ済みです。",
  not_open: "対象の local PR は open ではないため、マージできません。",
  conflict: "head が main と競合しています。rebase して出し直してください。",
  gate_not_passed: "審査ゲートを通過していないため、マージできません。",
  unauthorized: "Revisor がマージを認可しませんでした (workflow token を確認してください)。",
  unreachable: "Revisor に到達できませんでした。",
  timeout: "Revisor の応答を待ち切れませんでした。Revisor 側は処理を継続している可能性があります。",
  unknown: "Revisor がマージを拒否しました。Concordia の管理者に確認してください。",
};

/**
 * 失敗を理由と安全な文面へ落とす。 `RevisorMergeError` 以外 (想定外の例外) は
 * `unknown` に寄せる — 未知の例外文面を外へ出さないため。
 */
export function classifyMergeFailure(error: unknown): RevisorMergeFailure {
  if (!(error instanceof RevisorMergeError)) {
    return { reason: "unknown", detail: DETAIL.unknown };
  }
  if (error.timedOut) return { reason: "timeout", detail: DETAIL.timeout };
  if (error.status === null) return { reason: "unreachable", detail: DETAIL.unreachable };
  if (error.status === 401 || error.status === 403) {
    return { reason: "unauthorized", detail: DETAIL.unauthorized };
  }

  // 状態競合の説明は Revisor の 409 契約でのみ信用する。5xx 等の任意文言に
  // "already merged" が含まれても成功へ誤分類しない。
  const reason = error.status === 409 ? reasonFromText(error.revisorError ?? "") : null;
  if (reason) {
    // Revisor の原文には credentials、パス、private endpoint など任意の情報が混入し得る。
    // 文字列ベースの伏せ字では網羅できないため、行動を示す定型文だけを返す。
    return { reason, detail: DETAIL[reason] };
  }
  return { reason: "unknown", detail: DETAIL.unknown };
}
