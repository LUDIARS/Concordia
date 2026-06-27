/**
 * 停止セッションの残作業続行 nudge.
 *
 * ユーザ指示 (2026-06-23):
 *   「Concordia は止まっているセッションに対して残作業を都度確認し、 実装タスクが
 *    あれば残作業がなくなるまで実装させる。 人間の判断が必要になったら進行を止める。
 *    『止まっている』 の判断は 1 時間応答がないこととする。」
 *
 * 仕組み:
 *   - 周期 (既定 10 分) で全 active session を走査。
 *   - 各 session の **transcript の最終更新時刻** (= 最後に応答した時刻) を見る。
 *     last_seen_at は WS ハートビート由来で「プロセス生存」 signal にすぎず、
 *     idle を表さない。 transcript mtime こそが「応答が止まった」 の真の signal。
 *   - idleSec (既定 3600) 以上無更新で、 かつ **ask マーカーで人間判断待ちでない**
 *     セッションにだけ、 「残作業を確認して続行 / 判断が要るなら ask で停止」 を
 *     `session.inject` で流し込む。
 *   - 一度 nudge したら cooldownSec (既定 idleSec と同じ) は再 nudge しない
 *     (per-session の in-memory タイムスタンプで抑止)。
 *
 * 意図的に人間判断を仰いで止まっている (ask マーカーを出して待っている) セッションは
 * 除外する — そこへ「続行しろ」 と被せると人間の判断停止を踏み潰すため。
 *
 * fire-and-forget: WS 未接続なら inject は silent drop。 status 変更は行わない。
 */

import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { getProvider } from "../providers/index.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import { readGoalFromMetadata, describeGoal, DEFAULT_GOAL, type Goal } from "./goal.js";

const log = createChildLogger("stall-nudge");

export const STALL_NUDGE_SOURCE = "auto:stall-nudge";

/** ask 判定で末尾から読む最大バイト数 (巨大 transcript を全読みしない)。 */
const TAIL_BYTES = 64 * 1024;

export interface StalledSessionNudgeOptions {
  repo: SessionsRepo;
  /** scan 周期 (ms)。 既定 10 分。 */
  intervalMs?: number;
  /** transcript 無更新がこの秒数を超えたら「停止」 とみなす。 既定 3600 (1h)。 */
  idleSec?: number;
  /** 一度 nudge したら次の nudge までこの秒数空ける。 既定 idleSec と同じ。 */
  cooldownSec?: number;
  /** OFF なら何もしない。 既定 ON。 */
  enabled?: boolean;
  /** epoch-ms を返す注入可能クロック (テスト用)。 既定 Date.now。 */
  now?: () => number;
  /** transcript の mtime(epoch-ms) を返す seam (テスト用)。 既定 fs。 */
  transcriptMtimeMs?: (s: SessionRow) => number | null;
  /** transcript 末尾テキストを返す seam (テスト用)。 既定 fs。 */
  readTranscriptTail?: (s: SessionRow) => string | null;
}

export interface StalledSessionNudgeHandle {
  stop: () => void;
  /** 1 周分の走査を即実行 (テスト・手動用)。 nudge した session id を返す。 */
  runOnce: () => string[];
}

/** session の transcript ファイルパスを解決する (sweeper.tryRecover と同じ規約)。 */
export function resolveTranscriptPath(s: SessionRow): string | null {
  if (s.transcript_path) return s.transcript_path;
  const p = getProvider(s.provider);
  if (!p) return null;
  return p.transcriptPath(s.id, s.repo_path);
}

function defaultMtimeMs(s: SessionRow): number | null {
  const path = resolveTranscriptPath(s);
  if (!path || !existsSync(path)) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function defaultReadTail(s: SessionRow): string | null {
  const path = resolveTranscriptPath(s);
  if (!path || !existsSync(path)) return null;
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * transcript 末尾から「最後のメッセージが ask マーカー (人間判断待ち) か」 を判定する純関数。
 *
 * - Claude Code / Lictor relay の ask プロトコルは ```ask フェンス付きコードブロック。
 * - 最後の assistant メッセージにそのフェンスがあり、 かつその後に user メッセージが
 *   無ければ「人間の回答待ち」 とみなす (回答済みなら user 行が後に来るため除外)。
 * - JSONL でなくとも (生テキスト fallback)、 末尾付近に ```ask があれば awaiting 扱い。
 *
 * 保守的: 判定不能なら false (= nudge 対象に含める)。 末尾の "?" だけでは awaiting に
 * しない (assistant の修辞疑問で誤検知するため)。 ask マーカーを唯一の強 signal とする。
 */
export function isAwaitingHumanInput(tail: string | null): boolean {
  if (!tail) return false;
  const lines = tail.split(/\r?\n/).filter((l) => l.trim());
  // JSONL として末尾から解釈を試みる。
  let sawAskInLastAssistant = false;
  let resolved = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue; // JSON でない行はスキップ (末尾が途中で切れている場合など)
    }
    const o = obj as Record<string, unknown>;
    const role = (o.role ?? o.type) as string | undefined;
    if (role === "user" || o.type === "tool_result") {
      // 直近の意味のあるイベントが user 入力 → 既に回答済み or 入力直後 → 待ちでない。
      resolved = true;
      break;
    }
    if (role === "assistant") {
      const text = extractAllText(o);
      if (text && hasAskMarker(text)) sawAskInLastAssistant = true;
      resolved = true;
      break;
    }
  }
  if (resolved) return sawAskInLastAssistant;
  // JSONL として解釈できない (生テキスト)。 末尾に ask フェンスがあれば awaiting。
  return hasAskMarker(tail);
}

/** ```ask フェンス (情報文字列 ask) を含むか。 */
function hasAskMarker(text: string): boolean {
  return /(^|\n)\s*```ask\b/.test(text);
}

function extractAllText(msg: Record<string, unknown>): string {
  const content = (msg.content ?? (msg.message as Record<string, unknown> | undefined)?.content) as unknown;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        parts.push((part as { text: string }).text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * nudge 本文。 セッションのゴールで挙動を出し分ける (③ 残作業自走):
 *  - complete: 残作業がなくなるまで自走で続行。
 *  - scoped: ゴール範囲内の残作業のみ進め、 範囲超過は ask で確認。
 *  - watch: 自走しない。 残作業を一覧提示して進めてよいか確認する。
 * いずれも人間判断が要る点では ask で停止する。
 */
export function buildNudgeText(_provider: string, goal: Goal = DEFAULT_GOAL): string {
  if (goal.mode === "watch") {
    return [
      "[自動確認] 1 時間ほど応答が止まっているようです。",
      "",
      "- このセッションは様子見モードです。 残作業を一覧で提示し、 どれを進めてよいか",
      "  ユーザに確認してください (**自走しない**)。",
      "- 残作業が無ければ `/session-end` で終了してください。",
    ].join("\n");
  }
  const scopeLine =
    goal.mode === "scoped" && goal.text
      ? `- ゴール「${goal.text}」の範囲内の残作業を進め、 範囲を超える作業は ask で確認してください。`
      : "- 進行中の作業・Todo に未完があれば、 **残作業がなくなるまで実装を続けて**ください。";
  return [
    `[自動確認] 1 時間ほど応答が止まっているようです。 ゴール「${describeGoal(goal)}」に沿って残作業を確認してください。`,
    "",
    scopeLine,
    "- 人間の判断が必要な点 (方針が割れる / 破壊的操作 / 本番影響不明 / 仕様が曖昧 等) が",
    "  出たら、 決め打ちせず ask マーカーで質問して **進行を止めて**ください。",
    "- 残作業が無ければ `/session-end` で終了してください。",
  ].join("\n");
}

/**
 * nudge すべきかの純判定。
 * - idle 閾値未満なら false。
 * - 人間判断待ち (awaiting) なら false。
 * - 直近 nudge から cooldown 未満なら false。
 */
export function shouldNudge(args: {
  idleMs: number;
  idleThresholdMs: number;
  awaiting: boolean;
  lastNudgeMs: number | null;
  cooldownMs: number;
  nowMs: number;
}): boolean {
  if (args.idleMs < args.idleThresholdMs) return false;
  if (args.awaiting) return false;
  if (args.lastNudgeMs != null && args.nowMs - args.lastNudgeMs < args.cooldownMs) return false;
  return true;
}

export function startStalledSessionNudge(
  opts: StalledSessionNudgeOptions,
): StalledSessionNudgeHandle {
  const intervalMs = opts.intervalMs ?? 10 * 60 * 1000;
  const idleSec = opts.idleSec ?? 3600;
  const cooldownSec = opts.cooldownSec ?? idleSec;
  const enabled = opts.enabled ?? true;
  const now = opts.now ?? Date.now;
  const mtimeOf = opts.transcriptMtimeMs ?? defaultMtimeMs;
  const readTail = opts.readTranscriptTail ?? defaultReadTail;

  const idleThresholdMs = idleSec * 1000;
  const cooldownMs = cooldownSec * 1000;
  /** per-session の最終 nudge 時刻 (epoch-ms)。 */
  const lastNudge = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;

  function runOnce(): string[] {
    if (!enabled) return [];
    const nowMs = now();
    const active = opts.repo.findAllActive();
    const activeIds = new Set(active.map((s) => s.id));
    // 消えた session の cooldown 記録を掃除。
    for (const id of lastNudge.keys()) {
      if (!activeIds.has(id)) lastNudge.delete(id);
    }

    const nudged: string[] = [];
    for (const s of active) {
      const mtime = mtimeOf(s);
      if (mtime == null) continue; // transcript 不明 (idle 計測不能) はスキップ。
      const idleMs = nowMs - mtime;
      // 安い判定 (idle / cooldown) を先に。 awaiting は transcript 読みが要るので候補だけ評価。
      if (
        !shouldNudge({
          idleMs,
          idleThresholdMs,
          awaiting: false,
          lastNudgeMs: lastNudge.get(s.id) ?? null,
          cooldownMs,
          nowMs,
        })
      ) {
        continue;
      }
      const awaiting = isAwaitingHumanInput(readTail(s));
      if (awaiting) {
        log.debug({ session_id: s.id }, "skip nudge: awaiting human input (ask)");
        continue;
      }
      lastNudge.set(s.id, nowMs);
      eventBus.emit({
        type: "session.inject",
        target_session_id: s.id,
        text: buildNudgeText(s.provider, readGoalFromMetadata(s.metadata)),
        source: STALL_NUDGE_SOURCE,
        ts: Math.floor(nowMs / 1000),
      });
      nudged.push(s.id);
      log.info(
        { session_id: s.id, idle_sec: Math.round(idleMs / 1000) },
        "stalled session nudged to continue",
      );
    }
    return nudged;
  }

  if (enabled) {
    timer = setInterval(() => {
      try {
        runOnce();
      } catch (err) {
        log.warn({ err: (err as Error).message }, "stall-nudge tick failed");
      }
    }, intervalMs);
    timer.unref?.();
    log.info({ intervalMs, idleSec, cooldownSec }, "stalled-session nudge started");
  } else {
    log.info("stalled-session nudge disabled");
  }

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
}
