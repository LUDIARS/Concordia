/**
 * "違う作業" 検出. 直近の event から file 名前空間 (top dir) や prompt の
 * キーワードクラスタを抽出し、 直前の主要領域から **シフトした** 場合に true.
 */

import type { SessionEventRow } from "../shared/types.js";

const RECENT_LOOKBACK = 8;

export interface TopicSnapshot {
  primaryArea: string;            // 例: "src/api" / "tests" / "docs"
  fileTopDirs: Set<string>;       // 直近の編集 top dir 集合
  promptKeywords: Set<string>;    // 直近 prompt の主要キーワード
}

export function snapshotTopics(events: SessionEventRow[]): TopicSnapshot {
  const dirs = new Set<string>();
  const keywords = new Set<string>();
  let counter: Record<string, number> = {};

  for (const ev of events) {
    if (ev.kind === "edit") {
      const payload = safeParse(ev.payload);
      const file: string = payload?.file ?? "";
      const top = topDir(file);
      if (top) {
        dirs.add(top);
        counter[top] = (counter[top] ?? 0) + 1;
      }
    } else if (ev.kind === "prompt") {
      const payload = safeParse(ev.payload);
      const summary: string = payload?.summary ?? "";
      for (const w of extractKeywords(summary)) keywords.add(w);
    }
  }
  const primaryArea = Object.entries(counter).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  return { primaryArea, fileTopDirs: dirs, promptKeywords: keywords };
}

/**
 * @returns true なら "違う領域" にシフトしたとみなす
 */
export function detectTopicShift(
  prevEvents: SessionEventRow[],
  newEvent: SessionEventRow,
): boolean {
  if (newEvent.kind !== "edit" && newEvent.kind !== "prompt") return false;

  const recent = prevEvents.slice(-RECENT_LOOKBACK);
  const snap = snapshotTopics(recent);

  if (newEvent.kind === "edit") {
    const payload = safeParse(newEvent.payload);
    const top = topDir(payload?.file ?? "");
    if (!top) return false;
    return snap.fileTopDirs.size > 0 && !snap.fileTopDirs.has(top);
  }
  if (newEvent.kind === "prompt") {
    const payload = safeParse(newEvent.payload);
    const summary: string = payload?.summary ?? "";
    const newKw = extractKeywords(summary);
    if (newKw.size === 0) return false;
    if (snap.promptKeywords.size === 0) return false;
    // 既知 keywords に対して新 keywords のヒット率が低ければシフト
    let overlap = 0;
    for (const k of newKw) if (snap.promptKeywords.has(k)) overlap++;
    return overlap === 0; // 全くかぶってない時のみ shift とみなす
  }
  return false;
}

function topDir(file: string): string {
  if (!file) return "";
  const parts = file.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(0, 2).join("/");
}

function extractKeywords(text: string): Set<string> {
  // 簡易: 英単語 + ASCII identifier + 全角を除いて 4 文字以上の token を拾う
  const out = new Set<string>();
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

const STOPWORDS = new Set([
  "this", "that", "with", "from", "into", "have", "been", "were", "make", "made",
  "more", "less", "than", "which", "what", "when", "where", "their", "there",
  "should", "could", "would", "about", "after", "before", "some", "type",
  "true", "false", "null", "function", "return", "const", "value", "field",
]);

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}
