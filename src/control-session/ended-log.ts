/**
 * 管制が閉じたセッションの記録。次の 1 時間まとめで列挙し、投稿に成功したら消す。
 * 人が編集する設定ではない実行時の内部状態なので、設定レジストリの名前空間の外のキーに置く。
 *
 * @implements spec/feature/control-session.md §7
 */
export const CONTROL_ENDED_LOG_KEY = "control_session.recent_ended";
/** まとめまでに溜める上限 (古いものから捨てる)。 */
export const CONTROL_ENDED_LOG_LIMIT = 50;

export interface EndedSessionRecord {
  session_id: string;
  project: string;
  reason: string;
  ended_at: number;
}

interface SettingsPort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export function parseEndedLog(raw: string | null): EndedSessionRecord[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is EndedSessionRecord => !!item && typeof item === "object"
      && typeof (item as EndedSessionRecord).session_id === "string"
      && typeof (item as EndedSessionRecord).project === "string"
      && typeof (item as EndedSessionRecord).reason === "string"
      && typeof (item as EndedSessionRecord).ended_at === "number");
  } catch {
    return [];
  }
}

export function createEndedLog(settings: SettingsPort) {
  return {
    list: (): EndedSessionRecord[] => parseEndedLog(settings.get(CONTROL_ENDED_LOG_KEY)),
    append(records: readonly EndedSessionRecord[]): void {
      if (!records.length) return;
      const next = [...parseEndedLog(settings.get(CONTROL_ENDED_LOG_KEY)), ...records].slice(-CONTROL_ENDED_LOG_LIMIT);
      settings.set(CONTROL_ENDED_LOG_KEY, JSON.stringify(next));
    },
    clear: (): void => settings.delete(CONTROL_ENDED_LOG_KEY),
  };
}
