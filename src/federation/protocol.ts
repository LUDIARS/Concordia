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

const egressRequestSchema = z.object({
  v: versionField,
  type: z.literal("egress-request"),
  request_id: z.string().min(1).max(100),
  guild_id: z.string().min(1).max(100),
  channel_id: z.string().min(1).max(100),
  text: z.string().min(1).max(8_000),
}).passthrough();

const egressResultSchema = z.object({
  v: versionField,
  type: z.literal("egress-result"),
  request_id: z.string().min(1).max(100),
  ok: z.boolean(),
  error: z.string().max(500).optional(),
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
} as const;

export type FederationHelloFrame = z.infer<typeof helloSchema>;
export type FederationWelcomeFrame = z.infer<typeof welcomeSchema>;
export type FederationEventFrame = z.infer<typeof eventSchema>;
export type FederationIngressFrame = z.infer<typeof ingressSchema>;
export type FederationEgressRequestFrame = z.infer<typeof egressRequestSchema>;
export type FederationEgressResultFrame = z.infer<typeof egressResultSchema>;
export type FederationConfigSnapshot = z.infer<typeof configSnapshotSchema>;
export type FederationConfigSnapshotFrame = z.infer<typeof configSnapshotFrameSchema>;
export type FederationConfigUpdateFrame = z.infer<typeof configUpdateFrameSchema>;
export type FederationAckFrame = z.infer<typeof ackSchema>;
export type FederationErrorFrame = z.infer<typeof errorSchema>;
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
  | FederationErrorFrame;

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
  | { type: "egress-request"; request_id: string; guild_id: string; channel_id: string; text: string }
  | { type: "egress-result"; request_id: string; ok: boolean; error?: string }
  | { type: "config-snapshot"; snapshot: FederationConfigSnapshot }
  | { type: "config-update"; snapshot: FederationConfigSnapshot }
  | { type: "ack"; seq: number }
  | { type: "error"; code: FederationErrorCode; message: string };

export function serializeFederationFrame(frame: FederationFrameInput): string {
  return JSON.stringify({ ...frame, v: FEDERATION_PROTOCOL_VERSION });
}
