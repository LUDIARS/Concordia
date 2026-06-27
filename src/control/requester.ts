/**
 * 「誰の指示なのか」 (requester) を inject の source から解析し、 プロンプト本文に
 * 前置する純関数群。
 *
 * Concordia は複数名で同時に使える。 1 セッションに複数人が指示を投げうるので、
 *  - 人間 inject の本文に「誰の指示か」を前置して AI が起因者を把握できるようにし、
 *  - AskUserQuestion を出すときに「直近で指示した人」を @メンションして気付かせる。
 *
 * 起因者の identity は inject event の `source` ("discord:<uid>:<ch>:<msg>" /
 * "slack:<uid>:…") に既に埋まっているため、 専用の永続化は持たず session_events を
 * 後追いで読むだけにする (schema 変更不要)。
 *
 * SRP: source 解析 + プロンプト前置のみ。 DB アクセス / Discord 送信は呼び出し側。
 */

import type { SessionEventRow } from "../shared/types.js";

export interface Requester {
  platform: "discord" | "slack";
  /** プラットフォーム上のユーザ ID (Discord は <@id> メンションに使う)。 */
  userId: string;
}

/** "discord:<uid>:…" / "slack:<uid>:…" 形式の source から入力者を解析。 制御injectは null。 */
const SOURCE_RE = /^(discord|slack):([^:]+)/;

export function parseRequesterSource(source: unknown): Requester | null {
  if (typeof source !== "string") return null;
  const m = SOURCE_RE.exec(source);
  if (!m) return null;
  const userId = m[2].trim();
  if (!userId) return null;
  return { platform: m[1] as "discord" | "slack", userId };
}

/**
 * recentEvents (新しい順 = ts DESC) を走査し、 最後の **人間 inject** の入力者を返す。
 * 制御 inject (initial-work / enter-fallback / title-suggestion 等、 source が
 * discord/slack コロン形式でないもの) は飛ばす。 該当無しは null。
 */
export function lastHumanRequester(eventsNewestFirst: SessionEventRow[]): Requester | null {
  for (const ev of eventsNewestFirst) {
    if (ev.kind !== "inject") continue;
    let source: unknown;
    try {
      source = (JSON.parse(ev.payload) as { source?: unknown }).source;
    } catch {
      continue;
    }
    const r = parseRequesterSource(source);
    if (r) return r;
  }
  return null;
}

/**
 * 人間 inject のプロンプト本文に「誰の指示か」を 1 行で前置する。
 * 改行は入れない (TUI が前置行だけで送信確定してしまう事故を避ける)。
 */
export function prefixRequesterTag(label: string, text: string): string {
  return `「${label}」さんからの指示: ${text}`;
}
