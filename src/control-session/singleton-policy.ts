/**
 * 管制セッションを起動するか・そのままか・待つかの純判定。
 *
 * @implements spec/feature/control-session.md — 1. singleton の起動と復旧 / CC-CTL-INV-01
 */
import type { ControlHolder } from "./holder-store.js";

/** 起動から登録までを待つ猶予。これを過ぎても現れない・終了したら立て直す。 */
export const CONTROL_SPAWN_GRACE_MS = 5 * 60 * 1000;

export type SingletonDecision =
  | { action: "keep"; sessionId: string }
  | { action: "wait" }
  | { action: "spawn"; reason: "no_holder" | "not_live" };

export function decideControlSingleton(input: {
  holder: ControlHolder | null;
  /** 保持者の spawn ID で登録された active なセッション。無ければ null。 */
  liveSessionId: string | null;
  nowMs: number;
  graceMs?: number;
}): SingletonDecision {
  const graceMs = input.graceMs ?? CONTROL_SPAWN_GRACE_MS;
  if (!input.holder) return { action: "spawn", reason: "no_holder" };
  if (input.liveSessionId) return { action: "keep", sessionId: input.liveSessionId };
  // 直前の起動から猶予が過ぎるまでは重ねて起動しない (起動の連打をしない)。
  if (input.nowMs - input.holder.spawned_at < graceMs) return { action: "wait" };
  return { action: "spawn", reason: "not_live" };
}

/** セッション metadata の Cc spawn 相関 ID。 */
export function spawnIdOf(metadata: string | null): string | null {
  try {
    const value = (JSON.parse(metadata ?? "{}") as Record<string, unknown>).concordia_spawn_id;
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}
