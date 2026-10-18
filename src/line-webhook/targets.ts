/**
 * LINE webhook の転送先登録 (spec/feature/line-webhook-relay.md §転送先の登録)。
 *
 * 設定 `services.line_webhook_targets` は 1 行 1 件の JSON オブジェクト
 * (`{"name","url","host"?,"enabled"}`) の一覧。 ここは解釈と検証だけを持ち、
 * どこから読むか (schema_meta) と HTTP は呼び出し側が持つ。
 *
 * @implements spec/feature/line-webhook-relay.md — 転送先の登録
 */

import { contract } from './ontime-runtime.js'; /* augur-inject:import:f05c07c0 */
import augurContract_7d5d748a from './targets-parse.contract.js'; /* augur-inject:contract-predicate:bf3c5112 */
import augurContract_a5568c71 from './targets-resolve.contract.js'; /* augur-inject:contract-predicate:58f53949 */

export interface LineWebhookTarget {
  /** 受け口 `/hooks/line/:target` の `:target`。 */
  name: string;
  /** 転送先 URL (http / https)。 */
  url: string;
  /** 指定があれば転送時の Host ヘッダをこれにする。 */
  host: string | null;
  enabled: boolean;
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

/** 設定の 1 行 1 件を解釈する。 壊れた行と重複名は転送先に入れず、 理由を返す。 */
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

/** 受け口が叩かれた名前に対応する、 有効な転送先。 無ければ null (呼び出し側は 404)。 */
export function resolveLineWebhookTarget(
  targets: readonly LineWebhookTarget[],
  name: string,
): LineWebhookTarget | null {
  if (!LINE_WEBHOOK_TARGET_NAME_PATTERN.test(name)) return null;
  return targets.find((target) => target.name === name && target.enabled) ?? null;
}
// @ts-expect-error augur-inject
resolveLineWebhookTarget = contract(resolveLineWebhookTarget, { ...augurContract_a5568c71, contractId: 'line-wh-C-2', mode: 'observe', sample: 1, where: 'src/line-webhook/targets.ts:54', rule: 'contract-wrap', id: 'a5568c71' }); /* augur-inject:contract-wrap:a5568c71 */

/** 設定の PUT で使う検証。 1 件でも壊れていれば保存させない (「保存したのに効かない」 を作らない)。 */
export function validateLineWebhookTargetEntries(entries: readonly string[]): string | null {
  const { errors } = parseLineWebhookTargets(entries);
  return errors.length > 0 ? errors.join(" / ") : null;
}

/** schema_meta の生値 (JSON 配列の文字列) から転送先を読む。 壊れていれば転送先なし。 */
export function readLineWebhookTargets(raw: string | null): LineWebhookTarget[] {
  if (raw === null || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parseLineWebhookTargets(parsed.filter((item): item is string => typeof item === "string")).targets;
  } catch {
    return [];
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
  const unknownKey = Object.keys(record).find((key) => !["name", "url", "host", "enabled"].includes(key));
  if (unknownKey) return `未知のキー "${unknownKey}" があります`;

  const name = record.name;
  if (typeof name !== "string" || name.length > MAX_NAME_LENGTH || !LINE_WEBHOOK_TARGET_NAME_PATTERN.test(name)) {
    return `name は英小文字・数字・ハイフン (${MAX_NAME_LENGTH} 文字以内) で書きます`;
  }
  const url = record.url;
  if (typeof url !== "string" || !isHttpUrl(url)) return "url は http:// または https:// の URL で書きます";
  const host = record.host;
  if (host !== undefined && host !== null && (typeof host !== "string" || !HOST_PATTERN.test(host))) {
    return "host はホスト名 (任意で :ポート) で書きます";
  }
  const enabled = record.enabled;
  if (typeof enabled !== "boolean") return "enabled は true / false で書きます";
  return { name, url, host: typeof host === "string" ? host : null, enabled };
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
