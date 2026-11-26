/**
 * GLab-UnityHub のフレーム形式 (契約 v1 §2 メッセージ形式)。
 *
 * Unity 側 (UnityFoundation) と共有する形なので、 ここの名前・形・close code は契約から変えない。
 * 純関数だけを置く: 解析は失敗理由を値で返し、 throw しない。
 *
 * @implements spec/feature/glab-unity-hub.md §3 (GUH-PROTO)
 */
import { contract } from './ontime-runtime.js'; /* augur-inject:import:fc9c1ce7 */
import augurContract_ca7ebc3f from './frame-parse.contract.js'; /* augur-inject:contract-predicate:002fecdd */

/** 契約で決まったエラーコード。 */
export const HUB_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_request",
  "rate_limited",
  "upstream_unavailable",
  "internal",
] as const;
export type HubErrorCode = (typeof HUB_ERROR_CODES)[number];

/** 契約で決まった close code。 失効・期限切れ・未知トークンは 4401、 GLab から抜けた人と海外遮断は 4403。 */
export const HUB_CLOSE_CODES = {
  unauthorized: 4401,
  forbidden: 4403,
} as const;

/** 1 フレームの上限 (契約 §2 制限: 64 KiB)。 */
export const MAX_FRAME_BYTES = 64 * 1024;

/** 要求の id。 Unity は UUID を使うが、 契約は「クライアントの id」なので長さと文字種だけを縛る。 */
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** メソッド名 (`hub.whoami` など)。 */
const METHOD_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,3}$/;

export interface HubRequest {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface HubAuthFrame {
  readonly id: string | null;
  readonly token: string;
}

export type ParsedFrame =
  | { readonly kind: "request"; readonly request: HubRequest }
  | { readonly kind: "auth"; readonly auth: HubAuthFrame }
  | { readonly kind: "invalid"; readonly id: string | null; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** テキストフレーム 1 枚を読む。 バイナリや上限超過は呼び出し側で弾く。 */
export function parseFrame(text: string): ParsedFrame {
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
    return { kind: "invalid", id: null, message: "frame too large" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { kind: "invalid", id: null, message: "frame is not JSON" };
  }
  if (!isRecord(value)) return { kind: "invalid", id: null, message: "frame must be an object" };
  const id = typeof value.id === "string" && REQUEST_ID_RE.test(value.id) ? value.id : null;
  if (value.v !== 1) return { kind: "invalid", id, message: "unsupported protocol version" };
  if (typeof value.type !== "string") return { kind: "invalid", id, message: "type is required" };
  const payload = value.payload === undefined ? {} : value.payload;
  if (!isRecord(payload)) return { kind: "invalid", id, message: "payload must be an object" };
  if (value.type === "auth") {
    const token = payload.token;
    if (typeof token !== "string" || token.length === 0) {
      return { kind: "invalid", id, message: "auth payload requires token" };
    }
    return { kind: "auth", auth: { id, token } };
  }
  if (id === null) return { kind: "invalid", id: null, message: "id is required" };
  if (!METHOD_RE.test(value.type)) return { kind: "invalid", id, message: "unknown method format" };
  return { kind: "request", request: { id, type: value.type, payload } };
}

export function resultFrame(id: string, payload: unknown): string {
  return JSON.stringify({ v: 1, id, type: "result", payload: payload ?? {} });
}

/** id を持たない (要求に紐付かない) エラーは id を省いて送る。 */
export function errorFrame(id: string | null, code: HubErrorCode, message: string): string {
  return JSON.stringify({ v: 1, ...(id !== null ? { id } : {}), type: "error", payload: { code, message } });
}

export function eventFrame(event: string, data: unknown): string {
  return JSON.stringify({ v: 1, type: "event", payload: { event, data: data ?? {} } });
}

/** use case から投げる契約上のエラー。 code は契約の語彙だけ。 */
export class HubError extends Error {
  constructor(readonly code: HubErrorCode, message: string) {
    super(message);
    this.name = "HubError";
  }
}

/** 任意の例外を契約のエラーへ落とす。 内部例外の文言は外へ出さない。 */
export function toHubError(error: unknown): HubError {
  if (error instanceof HubError) return error;
  return new HubError("internal", "internal error");
}
// @ts-expect-error augur-inject
parseFrame = contract(parseFrame, { ...augurContract_ca7ebc3f, contractId: 'guh-C-4', mode: 'observe', sample: 1, where: 'src/glab-unity-hub/domain/protocol.ts:59', rule: 'contract-wrap', id: 'ca7ebc3f' }); /* augur-inject:contract-wrap:ca7ebc3f */
