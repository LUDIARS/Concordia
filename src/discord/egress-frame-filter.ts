/**
 * transcript.frame の relay 候補事前判定。
 *
 * tool-use / thinking / role!=assistant / 空 payload のフレームは egress の
 * handleTranscriptFrame が必ず drop する。 全フレームを直列 event キューに通すと
 * Discord 送信待ちの後ろに並び、 depth 単調増加 + ペイロードのメモリ滞留 +
 * per-task ログ洪水になる (2026-07-10 実測 depth 219+ / concordia.out.log 86MB/3日)。
 * enqueue する側がここで先に弾き、 relay され得るフレームだけを積む。
 *
 * payload の形だけで決まる判定に限定する。 session 状態 (active か等) は実行時に
 * 変わり得るため、 従来どおり egress 側で行う。
 */

import type { ConcordiaEvent } from "../events.js";

export type TranscriptFrameEvent = Extract<ConcordiaEvent, { type: "transcript.frame" }>;

export function isRelayCandidateFrame(ev: TranscriptFrameEvent): boolean {
  if (ev.kind === "text") {
    const p = ev.payload as { role?: string; text?: string } | null | undefined;
    return !!p && typeof p.text === "string" && p.text.length > 0 && p.role === "assistant";
  }
  if (ev.kind === "summary") {
    const p = ev.payload as { text?: string; summary?: string } | null | undefined;
    return typeof p?.text === "string" || typeof p?.summary === "string";
  }
  if (ev.kind === "image") {
    const p = ev.payload as { data?: string } | null | undefined;
    return typeof p?.data === "string" && p.data.length > 0;
  }
  return false;
}
