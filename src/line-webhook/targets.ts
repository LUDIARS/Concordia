/**
 * LINE webhook のサービス登録 (spec/feature/line-webhook-relay.md §サービスの登録)。
 *
 * 設定 `services.line_webhook_targets` は 1 行 1 件の JSON オブジェクト
 * (`{"name","url","host"?,"enabled","channel"?,"keywords"?}`) の一覧。 ここは解釈と検証だけを持ち、
 * どこから読むか (schema_meta) と HTTP は呼び出し側が持つ。
 * `channel` の無い行は自分の name をチャネル名とみなす (共用チャネル導入前の `mf` 行がそのまま読める)。
 *
 * @implements spec/feature/line-webhook-relay.md — サービスの登録
 */
import { contract } from './ontime-runtime.js'; /* augur-inject:import:f05c07c0 */
import augurContract_61a17526 from './targets-resolve.contract.js'; /* augur-inject:contract-predicate:58f53949 */
import augurContract_7d5d748a from './targets-parse.contract.js'; /* augur-inject:contract-predicate:bf3c5112 */

export interface LineWebhookTarget {
  /** サービス名。 中継トークンのキーと postback の包みに使う。 */
  name: string;
  /** 転送先 URL (http / https)。 */
  url: string;
  /** 指定があれば転送時の Host ヘッダをこれにする。 */
  host: string | null;
  enabled: boolean;
  /** 受け口 `/hooks/line/:channel` の `:channel`。 設定に無ければ name。 */
  channel: string;
  /** 呼びかけの言葉。 text の本文がこれで始まると、このサービスだけへ回す。 */
  keywords: string[];
}

export interface LineWebhookTargetParse {
  targets: LineWebhookTarget[];
  /** 採用しなかった項目の理由 (何行目か + 何が悪いか)。 */
  errors: string[];
}

export const LINE_WEBHOOK_TARGET_NAME_PATTERN = /^[a-z0-9-]+$/;
/** Host ヘッダに入れてよい形 (ホスト名 / IPv4 + 任意のポート)。 改行やパスを通さない。 */
const HOST_PATTERN = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const MAX_NAME_LENGTH = 64;
export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 32;
const KNOWN_KEYS = ["name", "url", "host", "enabled", "channel", "keywords"];

/** 設定の 1 行 1 件を解釈する。 壊れた行と重複名は登録に入れず、 理由を返す。 */
export function parseLineWebhookTargets(entries: readonly string[]): LineWebhookTargetParse {
  const targets: LineWebhookTarget[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const parsed = parseEntry(entry);
    if (typeof parsed === "string") {
      errors.push(`${index + 1} 件目: ${parsed}`);
      return;
    }
    if (seen.has(parsed.name)) {
      errors.push(`${index + 1} 件目: name "${parsed.name}" が重複しています`);
      return;
    }
    seen.add(parsed.name);
    targets.push(parsed);
  });
  return { targets, errors };
}
// @ts-expect-error augur-inject
parseLineWebhookTargets = contract(parseLineWebhookTargets, { ...augurContract_7d5d748a, contractId: 'line-wh-C-1', mode: 'observe', sample: 1, where: 'src/line-webhook/targets.ts:33', rule: 'contract-wrap', id: '7d5d748a' }); /* augur-inject:contract-wrap:7d5d748a */

/** 受け口が叩かれたチャネルに属する、 有効なサービス (設定順)。 空なら呼び出し側は 404。 */
export function channelServices(targets: readonly LineWebhookTarget[], channel: string): LineWebhookTarget[] {
  if (!LINE_WEBHOOK_TARGET_NAME_PATTERN.test(channel)) return [];
  return targets.filter((target) => target.channel === channel && target.enabled);
}
// @ts-expect-error augur-inject
channelServices = contract(channelServices, { ...augurContract_61a17526, contractId: 'line-wh-C-2', mode: 'observe', sample: 1, where: 'src/line-webhook/targets.ts:62', rule: 'contract-wrap', id: '61a17526' }); /* augur-inject:contract-wrap:61a17526 */

/** 登録済みのチャネル名 (enabled は問わない、 初出順)。 */
export function listLineChannels(targets: readonly LineWebhookTarget[]): string[] {
  return [...new Set(targets.map((target) => target.channel))];
}

/** 設定の PUT で使う検証。 1 件でも壊れていれば保存させない (「保存したのに効かない」 を作らない)。 */
export function validateLineWebhookTargetEntries(entries: readonly string[]): string | null {
  const { errors } = parseLineWebhookTargets(entries);
  return errors.length > 0 ? errors.join(" / ") : null;
}

/** schema_meta の生値 (JSON 配列の文字列) からサービスを読む。 壊れていればサービスなし。 */
export function readLineWebhookTargets(raw: string | null): LineWebhookTarget[] {
  return parseLineWebhookTargets(readRawEntries(raw) ?? []).targets;
}

/** 呼びかけの言葉の検証。 前後の空白を落とした値を返す。 壊れていれば理由。 */
export function normalizeKeywords(value: unknown): string[] | string {
  if (!Array.isArray(value)) return "keywords は文字列の配列で書きます";
  if (value.length > MAX_KEYWORDS) return `keywords は ${MAX_KEYWORDS} 個までです`;
  const keywords: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return "keywords は文字列の配列で書きます";
    const word = item.trim();
    if (word === "" || word.length > MAX_KEYWORD_LENGTH) return `keywords の各要素は 1〜${MAX_KEYWORD_LENGTH} 文字です`;
    if (keywords.includes(word)) return `keywords に "${word}" が重複しています`;
    keywords.push(word);
  }
  return keywords;
}

/**
 * 設定の生値のうち、 name のサービスの keywords だけを差し替えた 1 行 1 件の一覧を返す
 * (他の行・他のキーは書き換えない)。 サービスが無ければ null。
 */
export function replaceTargetKeywords(raw: string | null, name: string, keywords: readonly string[]): string[] | null {
  const entries = readRawEntries(raw);
  if (!entries) return null;
  let found = false;
  const next = entries.map((entry) => {
    const parsed = parseEntry(entry);
    if (typeof parsed === "string" || parsed.name !== name) return entry;
    found = true;
    return JSON.stringify({ ...(JSON.parse(entry) as Record<string, unknown>), keywords });
  });
  return found ? next : null;
}

function readRawEntries(raw: string | null): string[] | null {
  if (raw === null || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return null;
  }
}

function parseEntry(entry: string): LineWebhookTarget | string {
  let value: unknown;
  try {
    value = JSON.parse(entry);
  } catch {
    return "JSON オブジェクトとして読めません";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "JSON オブジェクトではありません";
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !KNOWN_KEYS.includes(key));
  if (unknownKey) return `未知のキー "${unknownKey}" があります`;

  const name = record.name;
  if (!isName(name)) return `name は英小文字・数字・ハイフン (${MAX_NAME_LENGTH} 文字以内) で書きます`;
  const url = record.url;
  if (typeof url !== "string" || !isHttpUrl(url)) return "url は http:// または https:// の URL で書きます";
  const host = record.host;
  if (host !== undefined && host !== null && (typeof host !== "string" || !HOST_PATTERN.test(host))) {
    return "host はホスト名 (任意で :ポート) で書きます";
  }
  const enabled = record.enabled;
  if (typeof enabled !== "boolean") return "enabled は true / false で書きます";
  const channel = record.channel ?? name;
  if (!isName(channel)) return `channel は英小文字・数字・ハイフン (${MAX_NAME_LENGTH} 文字以内) で書きます`;
  const keywords = record.keywords === undefined ? [] : normalizeKeywords(record.keywords);
  if (typeof keywords === "string") return keywords;
  return { name, url, host: typeof host === "string" ? host : null, enabled, channel, keywords };
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_NAME_LENGTH && LINE_WEBHOOK_TARGET_NAME_PATTERN.test(value);
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
