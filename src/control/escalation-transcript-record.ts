/**
 * Cc が応答できないときの transcript record 宣言のパーサ
 * (spec/feature/escalation-mode.md §1).
 *
 * Cc が落ちていると API を呼べない。 そのとき復旧セッションは provider の永続 transcript に
 * `ESCALATION` と明記した record を残して宣言する。 この宣言は API の成功を待たない。
 * Cc は復帰後にこの record を取り込んで同じ内容の escalation_event を作る。
 *
 * ここは純関数だけを置く (DB も HTTP も持たない)。 取り込みの副作用は
 * escalation-transcript-intake.ts が担う (SRP)。
 */

/** transcript 本文から宣言を見つけるためのマーカー。 */
export const ESCALATION_MARKER = "ESCALATION";

export interface EscalationTranscriptStart {
  action: "start";
  reason: string;
  at: number;
  repo: string | null;
}

export interface EscalationTranscriptEnd {
  action: "end";
  at: number;
  note: string | null;
}

export type EscalationTranscriptRecord = EscalationTranscriptStart | EscalationTranscriptEnd;

/**
 * transcript frame の payload から本文らしき文字列を取り出す。
 * provider ごとに frame の形が違うので、 文字列に見えるフィールドを浅く拾う。
 */
export function extractFrameText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["text", "content", "message", "body", "summary"]) {
    const value = record[key];
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") parts.push(item);
        else if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
          parts.push((item as Record<string, string>).text);
        }
      }
    }
  }
  return parts.join("\n");
}

/**
 * `ESCALATION start reason="..." at=<epoch|ISO> repo=<path>` /
 * `ESCALATION end at=<epoch|ISO> note="..."` を読む。
 *
 * `at` を省いた宣言は frame の ts を開始時刻に使う (`fallbackTs`)。 停電同然の状況で
 * 時刻を手で書かせると宣言そのものが書かれなくなるため、 必須にはしない。
 * `reason` の無い start は宣言として受け取らない — API 側と同じ理由で、
 * 理由の無い記録は後追いレビューの対象を特定できない。
 */
export function parseEscalationTranscriptRecord(
  text: string,
  fallbackTs: number,
): EscalationTranscriptRecord | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const marker = line.indexOf(ESCALATION_MARKER);
    if (marker < 0) continue;
    const body = line.slice(marker + ESCALATION_MARKER.length).trim();
    const action = /^start\b/i.test(body) ? "start" : /^(end|release)\b/i.test(body) ? "end" : null;
    if (!action) continue;

    const fields = parseFields(body);
    const at = parseTimestamp(fields.at) ?? fallbackTs;
    if (action === "start") {
      const reason = fields.reason?.trim();
      if (!reason) continue;
      return { action: "start", reason, at, repo: fields.repo?.trim() || null };
    }
    return { action: "end", at, note: fields.note?.trim() || null };
  }
  return null;
}

/** `key="quoted value"` と `key=bare` の両方を読む。 */
function parseFields(body: string): Record<string, string | undefined> {
  const fields: Record<string, string | undefined> = {};
  const pattern = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    fields[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  }
  return fields;
}

/** epoch 秒 / epoch ミリ秒 / ISO 8601 を epoch 秒へ揃える。 */
function parseTimestamp(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    return value > 1e11 ? Math.floor(value / 1000) : value;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}
