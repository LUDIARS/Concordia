/**
 * 管制セッションの保持者 (いま有効な世代) の永続化。設定ストアの 1 キーに JSON で置く。
 *
 * @implements spec/feature/control-session.md — 1. singleton の起動と復旧 / CC-CTL-INV-01
 */
import type { SettingsStore } from "../admin/settings-store.js";

/**
 * 人が編集する設定ではなく実行時の内部状態なので、設定レジストリの名前空間 (admin. / harness.) の外に置く
 * (src/config/settings/coverage.test.ts はその名前空間のキーを設定として数える)。
 */
export const CONTROL_HOLDER_KEY = "control_session.holder";
/** 退役した世代の spawn ID を覚えておく数 (終了の案内を 1 回送るため)。 */
const RETIRED_LIMIT = 5;

export interface ControlHolder {
  spawn_id: string;
  generation: number;
  spawned_at: number;
  retired: RetiredControl[];
}

export interface RetiredControl {
  spawn_id: string;
  /** 終了の案内を送ったか。 */
  notified: boolean;
}

function isRetired(value: unknown): value is RetiredControl {
  const record = value as Record<string, unknown> | null;
  return !!record && typeof record.spawn_id === "string" && typeof record.notified === "boolean";
}

/** 保存値を読む。壊れていれば null (= 保持者なし)。 */
export function parseControlHolder(raw: string | null): ControlHolder | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.spawn_id !== "string" || !value.spawn_id) return null;
    if (typeof value.generation !== "number" || !Number.isInteger(value.generation)) return null;
    if (typeof value.spawned_at !== "number") return null;
    const retired = Array.isArray(value.retired) ? value.retired.filter(isRetired) : [];
    return { spawn_id: value.spawn_id, generation: value.generation, spawned_at: value.spawned_at, retired };
  } catch {
    return null;
  }
}

/** 新しい世代へ交代した保持者。旧世代は退役一覧の先頭に入る。 */
export function nextControlHolder(previous: ControlHolder | null, spawnId: string, nowMs: number): ControlHolder {
  const retired = previous
    ? [{ spawn_id: previous.spawn_id, notified: false }, ...previous.retired].slice(0, RETIRED_LIMIT)
    : [];
  return { spawn_id: spawnId, generation: (previous?.generation ?? 0) + 1, spawned_at: nowMs, retired };
}

export class ControlHolderStore {
  constructor(private readonly store: Pick<SettingsStore, "get" | "set" | "delete">) {}

  read(): ControlHolder | null {
    return parseControlHolder(this.store.get(CONTROL_HOLDER_KEY));
  }

  write(holder: ControlHolder): void {
    this.store.set(CONTROL_HOLDER_KEY, JSON.stringify(holder));
  }

  clear(): void {
    this.store.delete(CONTROL_HOLDER_KEY);
  }

  /** 退役世代への終了案内を送ったことを記録する。 */
  markRetiredNotified(spawnId: string): void {
    const holder = this.read();
    if (!holder) return;
    this.write({
      ...holder,
      retired: holder.retired.map((r) => (r.spawn_id === spawnId ? { ...r, notified: true } : r)),
    });
  }
}
