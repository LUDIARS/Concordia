/**
 * Discord チャット中継の転送先登録 (spec/feature/discord-chat-relay.md §転送先の登録)。
 *
 * 設定 `services.discord_chat_relay_targets` は 1 行 1 件の JSON オブジェクト
 * (`{"name","url","host"?,"channelIds","noticeChannelIds"?,"enabled"}`) の一覧。 ここは解釈と検証だけを持ち、
 * どこから読むか (schema_meta) と Discord・HTTP は呼び出し側が持つ。
 * 作法は src/line-webhook/targets.ts と同じ。
 *
 * @implements spec/feature/discord-chat-relay.md — 転送先の登録
 */

import { contract } from './ontime-runtime.js'; /* augur-inject:import:c5697fd4 */
import augurContract_6da0782e from './targets.contract.js'; /* augur-inject:contract-predicate:6ae6c0fb */

export interface DiscordChatRelayTarget {
  /** ヘッダ `X-Concordia-Discord-Target` に載る識別子。 */
  name: string;
  /** 転送先 URL (http / https)。 */
  url: string;
  /** 指定があれば転送時の Host ヘッダをこれにする。 */
  host: string | null;
  /** 中継するチャンネル (この中のスレッドも含む)。 1 件以上。 */
  channelIds: string[];
  /** bot / webhook のお知らせだけを中継するチャンネル (この中のスレッドも含む)。 省略は空。 */
  noticeChannelIds: string[];
  enabled: boolean;
}

export interface DiscordChatRelayTargetParse {
  targets: DiscordChatRelayTarget[];
  /** 採用しなかった項目の理由 (何行目か + 何が悪いか)。 */
  errors: string[];
}

export const DISCORD_CHAT_RELAY_TARGET_NAME_PATTERN = /^[a-z0-9-]+$/;
const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;
/** Host ヘッダに入れてよい形 (ホスト名 / IPv4 + 任意のポート)。 改行やパスを通さない。 */
const HOST_PATTERN = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const MAX_NAME_LENGTH = 64;
const KNOWN_KEYS = ["name", "url", "host", "channelIds", "noticeChannelIds", "enabled"];

/**
 * 設定の 1 行 1 件を解釈する。 壊れた行・重複名・既に他の target に割り当てたチャンネルを含む行は
 * 転送先に入れず、 理由を返す (DCR-INV-01: 同じ発言を 2 か所へ送らない)。 お知らせのチャンネルも
 * 同じ割り当てに数える (DCR-INV-13)。
 */
export function parseDiscordChatRelayTargets(entries: readonly string[]): DiscordChatRelayTargetParse {
  const targets: DiscordChatRelayTarget[] = [];
  const errors: string[] = [];
  const names = new Set<string>();
  const channelOwners = new Map<string, string>();
  entries.forEach((entry, index) => {
    const parsed = parseEntry(entry);
    if (typeof parsed === "string") {
      errors.push(`${index + 1} 件目: ${parsed}`);
      return;
    }
    if (names.has(parsed.name)) {
      errors.push(`${index + 1} 件目: name "${parsed.name}" が重複しています`);
      return;
    }
    const owned = [...parsed.channelIds, ...parsed.noticeChannelIds];
    const taken = owned.find((id) => channelOwners.has(id));
    if (taken) {
      errors.push(`${index + 1} 件目: channelId ${taken} は "${channelOwners.get(taken)}" に割り当て済みです`);
      return;
    }
    names.add(parsed.name);
    for (const id of owned) channelOwners.set(id, parsed.name);
    targets.push(parsed);
  });
  return { targets, errors };
}
// @ts-expect-error augur-inject
parseDiscordChatRelayTargets = contract(parseDiscordChatRelayTargets, { ...augurContract_6da0782e, contractId: 'dcr-C-1', mode: 'observe', sample: 1, where: 'src/discord-chat-relay/targets.ts:41', rule: 'contract-wrap', id: '6da0782e' }); /* augur-inject:contract-wrap:6da0782e */

/** 設定の PUT で使う検証。 1 件でも壊れていれば保存させない (「保存したのに効かない」 を作らない)。 */
export function validateDiscordChatRelayTargetEntries(entries: readonly string[]): string | null {
  const { errors } = parseDiscordChatRelayTargets(entries);
  return errors.length > 0 ? errors.join(" / ") : null;
}

/** schema_meta の生値 (JSON 配列の文字列) から転送先を読む。 壊れていれば転送先なし。 */
export function readDiscordChatRelayTargets(raw: string | null): DiscordChatRelayTarget[] {
  if (raw === null || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parseDiscordChatRelayTargets(parsed.filter((item): item is string => typeof item === "string")).targets;
  } catch {
    return [];
  }
}

function parseEntry(entry: string): DiscordChatRelayTarget | string {
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
  if (typeof name !== "string" || name.length > MAX_NAME_LENGTH || !DISCORD_CHAT_RELAY_TARGET_NAME_PATTERN.test(name)) {
    return `name は英小文字・数字・ハイフン (${MAX_NAME_LENGTH} 文字以内) で書きます`;
  }
  const url = record.url;
  if (typeof url !== "string" || !isHttpUrl(url)) return "url は http:// または https:// の URL で書きます";
  const host = record.host;
  if (host !== undefined && host !== null && (typeof host !== "string" || !HOST_PATTERN.test(host))) {
    return "host はホスト名 (任意で :ポート) で書きます";
  }
  const channelIds = record.channelIds;
  if (!Array.isArray(channelIds) || channelIds.length === 0
    || !channelIds.every((id): id is string => typeof id === "string" && SNOWFLAKE_PATTERN.test(id))) {
    return "channelIds は Discord のチャンネル ID (数字 17〜20 桁) の配列 (1 件以上) で書きます";
  }
  if (new Set(channelIds).size !== channelIds.length) return "channelIds に同じチャンネルが重複しています";
  const noticeChannelIds = parseNoticeChannelIds(record.noticeChannelIds, channelIds);
  if (typeof noticeChannelIds === "string") return noticeChannelIds;
  const enabled = record.enabled;
  if (typeof enabled !== "boolean") return "enabled は true / false で書きます";
  return {
    name, url, host: typeof host === "string" ? host : null, channelIds: [...channelIds], noticeChannelIds, enabled,
  };
}

/** 省略は空。 人の発言のチャンネルと同じ ID は置けない (どちらの扱いか決まらなくなる)。 */
function parseNoticeChannelIds(value: unknown, channelIds: readonly string[]): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === "string" && SNOWFLAKE_PATTERN.test(id))) {
    return "noticeChannelIds は Discord のチャンネル ID (数字 17〜20 桁) の配列で書きます";
  }
  if (new Set(value).size !== value.length) return "noticeChannelIds に同じチャンネルが重複しています";
  const both = value.find((id) => channelIds.includes(id));
  if (both) return `channelId ${both} が channelIds と noticeChannelIds の両方にあります`;
  return [...value];
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
