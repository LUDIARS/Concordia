/**
 * 管制チャンネルの本文に載せる JST の時刻 (HH:MM)。
 *
 * @implements spec/feature/control-session.md §7
 */
const JST_OFFSET_SEC = 9 * 60 * 60;

export function formatJstClock(epochSec: number): string {
  const d = new Date((epochSec + JST_OFFSET_SEC) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
