import { contract } from './ontime-runtime.js'; /* augur-inject:import:2f829b73 */
import augurContract_ff902854 from './revisor-failure-reason.contract.js'; /* augur-inject:contract-predicate:b4d6aebe */
/**
 * Revisor への JSON リクエストと失敗理由の分類 (CC-RV-LIST-SCOPE-01)。
 *
 * 失敗を「打ち切り (timeout)」「到達不能 (unreachable)」「エラー応答 (http_error)」
 * 「応答不正 (invalid_response)」に分けて返す。 2026-10-02 に一覧取得が打ち切られ
 * 続けたとき、 呼び出し側には "This operation was aborted" / "invalid local PR listing"
 * しか残らず、 Revisor が遅いのか壊れているのか区別できなかった。
 */

export type RevisorRequestFailureReason =
  | "timeout"
  | "unreachable"
  | "http_error"
  | "invalid_response";

export class RevisorRequestError extends Error {
  constructor(
    message: string,
    readonly reason: RevisorRequestFailureReason,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "RevisorRequestError";
  }
}

/** 失敗理由を取り出す。 RevisorRequestError 以外は分類できないので null。 */
export function revisorFailureReason(error: unknown): RevisorRequestFailureReason | null {
  return error instanceof RevisorRequestError ? error.reason : null;
}

/**
 * fetch が投げた例外の分類。 打ち切りは自前の期限フラグで判定する — AbortError は
 * 期限切れ以外でも起き得るので、 例外の種類だけで timeout と断定しない。
 *
 * @implements CC-RV-LIST-SCOPE-01
 */
export function classifyRevisorRequestFailure(timedOut: boolean): RevisorRequestFailureReason {
  return timedOut ? "timeout" : "unreachable";
}
// @ts-expect-error augur-inject
classifyRevisorRequestFailure = contract(classifyRevisorRequestFailure, { ...augurContract_ff902854, contractId: 'rv-list-C-2', mode: 'observe', sample: 1, where: 'src/pr/revisor-http.ts:38', rule: 'contract-wrap', id: 'ff902854' }); /* augur-inject:contract-wrap:ff902854 */

export interface RevisorJsonRequest {
  fetchImpl: typeof fetch;
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  /** エラーメッセージの主語 (例: "Revisor /v1/local-prs?state=open")。 */
  label: string;
  /** 404 を例外にせず null として返す (単一取得で「無い」を区別するため)。 */
  allowNotFound?: boolean;
}

/**
 * JSON を取得する。 2xx なら本文 (JSON でなければ null)、 allowNotFound の 404 なら
 * null を返す。 それ以外は RevisorRequestError を投げる。 メッセージは従来の
 * `<label> failed (<status>)<: error>` 形を保つ (submission-reconcile の判定が依存する)。
 */
export async function requestRevisorJson(request: RevisorJsonRequest): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  try {
    let response: Response;
    try {
      response = await request.fetchImpl(request.url, { ...request.init, signal: controller.signal });
    } catch (error) {
      const reason = classifyRevisorRequestFailure(timedOut);
      const cause = error instanceof Error ? error.message : String(error);
      throw new RevisorRequestError(
        reason === "timeout"
          ? `${request.label} timed out after ${request.timeoutMs}ms`
          : `${request.label} request failed: ${cause}`,
        reason,
      );
    }
    if (request.allowNotFound && response.status === 404) return null;
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // 本文の読み取り中に打ち切られた場合も timeout として返す。
      if (timedOut) {
        throw new RevisorRequestError(`${request.label} timed out after ${request.timeoutMs}ms`, "timeout");
      }
      body = null;
    }
    if (!response.ok) {
      const error = body && typeof body === "object" && "error" in body ? body.error : null;
      const detail = typeof error === "string" ? `: ${error}` : "";
      throw new RevisorRequestError(
        `${request.label} failed (${response.status})${detail}`,
        "http_error",
        response.status,
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}
