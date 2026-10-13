/**
 * 連合リンク wire protocol v1 (本社 ⇄ 拠点)。
 *
 * ConcordiaEvent (プロセス内 event bus) とは独立した連合専用スキーマ。
 * spec/plan/multi-site-federation.md 未決事項の推奨どおり、拠点間互換は
 * このプロトコルの `v` だけで管理する (内部イベント形式の変更が拠点間の
 * 破壊的変更に直結しないようにする)。
 *
 * フレーム:
 *   site → hq : hello { site_id, token, site_version? }
 *   hq → site : welcome { hq_version, pending_events }
 *   hq → site : event { seq, payload }   (payload は不透明 JSON。中身は Phase 2+)
 *   hq → site : config-snapshot { snapshot } (link 確立直後の設定正本)
 *   hq → site : config-update { snapshot }   (明示再配布された設定正本)
 *   site → hq : ack { seq }              (seq 以下を受領済みとして outbox から削除)
 *   hq → site : error { code, message }  (close 直前の理由通知)
 *   双方向    : inquiry-request / inquiry-result (拠点間ワンショット調査、本社が中継)
 *   site → hq : activity-report { date_iso, sessions } (拠点のその日の作業記録、応答なし)
 *
 * 死活は WS プロトコルレベルの ping/pong (ws ライブラリ) で行い、
 * アプリフレームには持ち込まない。
 */

import { z } from "zod";

export const FEDERATION_PROTOCOL_VERSION = 1;

/** 拠点 ID: DNS ラベル風 (小文字英数 + ハイフン、先頭は英数、2〜64 文字)。 */
export const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

const versionField = z.literal(FEDERATION_PROTOCOL_VERSION);

const helloSchema = z.object({
  v: versionField,
  type: z.literal("hello"),
  site_id: z.string().regex(SITE_ID_PATTERN),
  token: z.string().min(1).max(512),
  site_version: z.string().max(100).optional(),
  platform: z.enum(["win32", "darwin"]).optional(),
}).passthrough();

const welcomeSchema = z.object({
  v: versionField,
  type: z.literal("welcome"),
  hq_version: z.string().max(100),
  pending_events: z.number().int().nonnegative(),
}).passthrough();

const eventSchema = z.object({
  v: versionField,
  type: z.literal("event"),
  seq: z.number().int().positive(),
  payload: z.unknown(),
}).passthrough();

const ingressSchema = z.object({
  v: versionField,
  type: z.literal("ingress"),
  guild_id: z.string().min(1).max(100),
  channel_id: z.string().min(1).max(100),
  message_id: z.string().min(1).max(100),
  author_id: z.string().min(1).max(100),
  author_label: z.string().min(1).max(200),
  text: z.string().min(1).max(8_000),
  ts: z.number().int().nonnegative(),
  /** 発言元スレッドに付いた forum タグ名 (拠点タグの解決は本社側で済んでいる)。 */
  applied_tag_names: z.array(z.string().min(1).max(100)).max(20).optional(),
}).passthrough();

/**
 * 拠点セッションの質問カード (SPEC-FED-SITE-FORUM-PARITY)。 本社はボタン / 選択メニューにして出し、
 * 押された回答を ingress の `answer` で拠点へ返す。
 */
export const egressQuestionSchema = z.object({
  question_id: z.number().int().positive(),
  prompt: z.string().min(1).max(2_000),
  options: z.array(z.object({
    label: z.string().min(1).max(100),
    description: z.string().max(100).optional(),
  })).max(25),
  multi_select: z.boolean().optional(),
});
export type FederationEgressQuestion = z.infer<typeof egressQuestionSchema>;

const egressRequestSchema = z.object({
  v: versionField,
  type: z.literal("egress-request"),
  request_id: z.string().min(1).max(100),
  guild_id: z.string().min(1).max(100),
  channel_id: z.string().min(1).max(100),
  text: z.string().min(1).max(8_000),
  /**
   * 通常セッションと同じ見た目で出すための webhook 名・アイコン (SPEC-FED-SITE-FORUM-PARITY)。
   * 古い本社は読み捨て、 従来どおり "Concordia" で出す。
   */
  username: z.string().min(1).max(80).optional(),
  avatar_url: z.string().url().max(500).optional(),
  /** 起動した人へのメンションを求める。 誰をメンションするかは本社が自分の台帳で決める (拠点は ID を渡さない)。 */
  mention_requester: z.boolean().optional(),
  question: egressQuestionSchema.optional(),
  /**
   * 本社で書かれた返信を拠点のセッションが読み込んだ印 (通常セッションの inject ✅ と同じ)。
   * 指定があれば本社は text を投稿せず、 この本社メッセージに ✅ を付ける。
   * 古い本社は読み捨てて text ("✅") を投稿する。
   */
  ack_message_id: z.string().regex(/^\d{17,20}$/).optional(),
}).passthrough();

const egressResultSchema = z.object({
  v: versionField,
  type: z.literal("egress-result"),
  request_id: z.string().min(1).max(100),
  ok: z.boolean(),
  error: z.string().max(500).optional(),
}).passthrough();

/**
 * 拠点で起動したセッションを本社の Session フォーラムへ映す (SPEC-FED-SITE-SESSION-MIRROR)。
 * 拠点 → 本社で投稿を立てる依頼、 本社 → 拠点で立てた投稿の宛先を返す。
 */
const mirrorOpenRequestSchema = z.object({
  v: versionField,
  type: z.literal("mirror-open-request"),
  request_id: z.string().min(1).max(100),
  session_id: z.string().min(1).max(200),
  title: z.string().min(1).max(100),
  text: z.string().min(1).max(2_000),
}).passthrough();

const mirrorOpenResultSchema = z.object({
  v: versionField,
  type: z.literal("mirror-open-result"),
  request_id: z.string().min(1).max(100),
  ok: z.boolean(),
  guild_id: z.string().min(1).max(100).optional(),
  channel_id: z.string().min(1).max(100).optional(),
  error: z.string().max(500).optional(),
}).passthrough();

/**
 * 拠点のその日の作業記録 (SPEC-FED-SITE-ACTIVITY、2026-10-14 neco 指示「日報は本社のみで更新する /
 * 各拠点がやったことは別途本社に送る」)。 拠点 → 本社の一方向。 同じ拠点・日付は後着で上書きするので
 * 応答は返さず、 拠点は定期的に送り直す。 古い本社は認証後の未知フレームとして読み捨てる。
 */
export const ACTIVITY_REPORT_MAX_SESSIONS = 80;
export const activitySessionSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(200).nullable(),
  repo: z.string().max(300).nullable(),
  branch: z.string().max(200).nullable(),
  provider: z.string().min(1).max(50),
  status: z.string().min(1).max(30),
  started_at: z.number().int().nonnegative(),
  ended_at: z.number().int().nonnegative().nullable(),
  duration_sec: z.number().int().nonnegative(),
}).strict();
export type FederationActivitySession = z.infer<typeof activitySessionSchema>;

const activityReportSchema = z.object({
  v: versionField,
  type: z.literal("activity-report"),
  date_iso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generated_at: z.number().int().nonnegative(),
  /** その日のセッション総数 (sessions が上限で切られていても総数は分かる)。 */
  session_count: z.number().int().nonnegative(),
  sessions: z.array(activitySessionSchema).max(ACTIVITY_REPORT_MAX_SESSIONS),
}).passthrough();

/**
 * 拠点間ワンショット調査 (SPEC-FED-INQUIRY)。 本社 ⇄ 拠点の双方向。 拠点同士は本社が中継する。
 * target / origin は site_id か本社を表す "hq"。
 */
export const INQUIRY_HQ = "hq";
export const INQUIRY_MAX_PROMPT = 8_000;
export const INQUIRY_MAX_OUTPUT = 64_000;
export const INQUIRY_MIN_TIMEOUT_SEC = 30;
export const INQUIRY_MAX_TIMEOUT_SEC = 600;
const inquiryParty = z.union([z.literal(INQUIRY_HQ), z.string().regex(SITE_ID_PATTERN)]);

const inquiryRequestSchema = z.object({
  v: versionField,
  type: z.literal("inquiry-request"),
  request_id: z.string().min(1).max(100),
  origin: inquiryParty,
  target: inquiryParty,
  prompt: z.string().min(1).max(INQUIRY_MAX_PROMPT),
  project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
  timeout_sec: z.number().int().min(INQUIRY_MIN_TIMEOUT_SEC).max(INQUIRY_MAX_TIMEOUT_SEC),
}).passthrough();

const inquiryResultSchema = z.object({
  v: versionField,
  type: z.literal("inquiry-result"),
  request_id: z.string().min(1).max(100),
  ok: z.boolean(),
  output: z.string().max(INQUIRY_MAX_OUTPUT).optional(),
  error: z.string().max(500).optional(),
  executed_by: inquiryParty,
  duration_ms: z.number().int().nonnegative().optional(),
}).passthrough();

const configSnapshotSchema = z.object({
  discord: z.record(z.string()),
  templates: z.array(z.object({
    id: z.string(),
    call_name: z.string(),
    title: z.string(),
    target_provider: z.string(),
    model: z.string().nullable(),
  }).strict()),
  /**
   * 本社の社員名簿のうち役職を持つ人 (管理職以上) (SPEC-FED-STAFF-ROLES)。 拠点は自分の名簿と比べて
   * 高いほうの役職で権限を判定する。 名前やメモは渡さない (ID と役職だけ)。 古い本社は送らない。
   */
  staff_roles: z.array(z.object({
    platform: z.enum(["discord", "slack"]),
    user_id: z.string().min(1).max(100),
    role: z.enum(["manager", "executive"]),
  }).strict()).max(1_000).optional(),
}).strict();

const configSnapshotFrameSchema = z.object({
  v: versionField,
  type: z.literal("config-snapshot"),
  snapshot: configSnapshotSchema,
}).passthrough();

const configUpdateFrameSchema = z.object({
  v: versionField,
  type: z.literal("config-update"),
  snapshot: configSnapshotSchema,
}).passthrough();

const ackSchema = z.object({
  v: versionField,
  type: z.literal("ack"),
  seq: z.number().int().positive(),
}).passthrough();

export const FEDERATION_ERROR_CODES = [
  "auth_failed",
  "unsupported_version",
  "invalid_frame",
  "replaced",
  "revoked",
] as const;
export type FederationErrorCode = (typeof FEDERATION_ERROR_CODES)[number];

const errorSchema = z.object({
  v: versionField,
  type: z.literal("error"),
  code: z.enum(FEDERATION_ERROR_CODES),
  message: z.string().max(500),
}).passthrough();

const frameSchemas = {
  hello: helloSchema,
  welcome: welcomeSchema,
  event: eventSchema,
  ingress: ingressSchema,
  "egress-request": egressRequestSchema,
  "egress-result": egressResultSchema,
  "config-snapshot": configSnapshotFrameSchema,
  "config-update": configUpdateFrameSchema,
  ack: ackSchema,
  error: errorSchema,
  "inquiry-request": inquiryRequestSchema,
  "inquiry-result": inquiryResultSchema,
  "mirror-open-request": mirrorOpenRequestSchema,
  "mirror-open-result": mirrorOpenResultSchema,
  "activity-report": activityReportSchema,
} as const;

export type FederationHelloFrame = z.infer<typeof helloSchema>;
export type FederationWelcomeFrame = z.infer<typeof welcomeSchema>;
export type FederationEventFrame = z.infer<typeof eventSchema>;
export type FederationIngressFrame = z.infer<typeof ingressSchema>;
export type FederationEgressRequestFrame = z.infer<typeof egressRequestSchema>;
/** 本社が Discord へ渡す形。 メンション先は本社の台帳で決めた起動者だけ (拠点の申告は使わない)。 */
export type FederationEgressDelivery = FederationEgressRequestFrame & { mention_user_id?: string };
export type FederationEgressResultFrame = z.infer<typeof egressResultSchema>;
export type FederationConfigSnapshot = z.infer<typeof configSnapshotSchema>;
export type FederationConfigSnapshotFrame = z.infer<typeof configSnapshotFrameSchema>;
export type FederationConfigUpdateFrame = z.infer<typeof configUpdateFrameSchema>;
export type FederationAckFrame = z.infer<typeof ackSchema>;
export type FederationErrorFrame = z.infer<typeof errorSchema>;
export type FederationInquiryRequestFrame = z.infer<typeof inquiryRequestSchema>;
export type FederationInquiryResultFrame = z.infer<typeof inquiryResultSchema>;
export type FederationMirrorOpenRequestFrame = z.infer<typeof mirrorOpenRequestSchema>;
export type FederationMirrorOpenResultFrame = z.infer<typeof mirrorOpenResultSchema>;
export type FederationActivityReportFrame = z.infer<typeof activityReportSchema>;
export type FederationFrame =
  | FederationHelloFrame
  | FederationWelcomeFrame
  | FederationEventFrame
  | FederationIngressFrame
  | FederationEgressRequestFrame
  | FederationEgressResultFrame
  | FederationConfigSnapshotFrame
  | FederationConfigUpdateFrame
  | FederationAckFrame
  | FederationErrorFrame
  | FederationInquiryRequestFrame
  | FederationInquiryResultFrame
  | FederationMirrorOpenRequestFrame
  | FederationMirrorOpenResultFrame
  | FederationActivityReportFrame;

export type FederationFrameType = FederationFrame["type"];

export type ParseFederationFrameResult =
  | { ok: true; frame: FederationFrame }
  | { ok: false; reason: "invalid_frame" | "unsupported_version" | "unknown_type"; detail?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * detail は拒否理由の監査ログに出る = 相手 (未認証でもよい) が長さを決められる。
 * ログを埋める手口を防ぐため、値そのものを出す箇所は必ずここを通して詰める。
 */
const MAX_DETAIL_LENGTH = 120;

function clampDetail(detail: string): string {
  return detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH)}…` : detail;
}

/** raw WS text → validated frame。連合面で受け付ける操作はここで列挙されたものだけ。 */
export function parseFederationFrame(raw: unknown): ParseFederationFrameResult {
  let input: unknown = raw;
  if (typeof raw === "string") {
    try {
      input = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "invalid_frame", detail: "not JSON" };
    }
  }
  if (!isRecord(input) || typeof input.type !== "string") {
    return { ok: false, reason: "invalid_frame", detail: "missing string type" };
  }
  if (input.v !== FEDERATION_PROTOCOL_VERSION) {
    return { ok: false, reason: "unsupported_version", detail: clampDetail(`v=${String(input.v)}`) };
  }
  // Object.hasOwn 必須: 素の object literal なので `type:"constructor"` /
  // `"toString"` / `"__proto__"` だと Object.prototype 由来の値が truthy で返り、
  // 直後の safeParse が TypeError を投げて未認証の相手に例外を起こさせられる
  // (= 接続を閉じずレート制限にも記録されないまま error チャンネルを埋められる)。
  if (!Object.hasOwn(frameSchemas, input.type)) {
    return { ok: false, reason: "unknown_type", detail: clampDetail(input.type) };
  }
  const schema = frameSchemas[input.type as FederationFrameType];
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_frame",
      detail: clampDetail(parsed.error.issues.map((issue) => issue.message).join("; ")),
    };
  }
  return { ok: true, frame: parsed.data as FederationFrame };
}

/**
 * 送信フレーム (v は serialize が付ける)。受信用の z.infer 型から Omit で導出しない:
 * `.passthrough()` が付ける index signature のせいで Omit が
 * `{[k: string]: unknown}` へ潰れ、任意の object が通ってしまうため
 * (union に対する Omit は共通キーしか残さないので二重に効かない)。
 * 送信側だけは明示的に列挙して、組み立てミスを型で捕まえる。
 */
export type FederationFrameInput =
  | { type: "hello"; site_id: string; token: string; site_version?: string; platform?: "win32" | "darwin" }
  | { type: "welcome"; hq_version: string; pending_events: number }
  | { type: "event"; seq: number; payload: unknown }
  | { type: "ingress"; guild_id: string; channel_id: string; message_id: string; author_id: string; author_label: string; text: string; ts: number; applied_tag_names?: readonly string[] }
  | { type: "egress-request"; request_id: string; guild_id: string; channel_id: string; text: string; username?: string; avatar_url?: string; mention_requester?: boolean; question?: FederationEgressQuestion; ack_message_id?: string }
  | { type: "egress-result"; request_id: string; ok: boolean; error?: string }
  | { type: "config-snapshot"; snapshot: FederationConfigSnapshot }
  | { type: "config-update"; snapshot: FederationConfigSnapshot }
  | { type: "ack"; seq: number }
  | { type: "error"; code: FederationErrorCode; message: string }
  | { type: "inquiry-request"; request_id: string; origin: string; target: string; prompt: string; project?: string; timeout_sec: number }
  | { type: "inquiry-result"; request_id: string; ok: boolean; output?: string; error?: string; executed_by: string; duration_ms?: number }
  | { type: "mirror-open-request"; request_id: string; session_id: string; title: string; text: string }
  | { type: "mirror-open-result"; request_id: string; ok: boolean; guild_id?: string; channel_id?: string; error?: string }
  | { type: "activity-report"; date_iso: string; generated_at: number; session_count: number; sessions: readonly FederationActivitySession[] };

export function serializeFederationFrame(frame: FederationFrameInput): string {
  return JSON.stringify({ ...frame, v: FEDERATION_PROTOCOL_VERSION });
}
