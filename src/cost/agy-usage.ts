/**
 * Antigravity CLI (`agy -p /usage`) の利用枠の出力を読む (純関数)。
 *
 * 2026-11-21 neco 指示「Neon の週間使用量みたいなやつがコストに出ない」。Codex (app-server) と
 * Claude (OAuth usage) と同じく、Gemini の 5H / 週間の残量とリセット時刻をコスト面に出す。
 *
 * 実測出力 (agy 1.5 系、タブ区切り・1 行 1 枠):
 *   Gemini Models\tWeekly Limit Remaining\t98%\t2026-11-28T08:55:11Z
 *   Gemini Models\tFive Hour Limit Remaining\t92%\t2026-11-21T13:55:11Z
 *   Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-28T09:30:06Z
 *   Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-28T09:30:06Z
 *
 * 値は「残り %」。使用率 (他 provider と同じ向き) は 100 - 残り で持つ。
 * 読めない行は捨て、1 行も読めなければ null (無言で 0% にしない)。
 *
 * @implements spec/feature/cost-observability.md Gemini（Antigravity CLI） C-4
 */

/** Gemini 全体の枠を表すグループ名 (agy の表記)。 */
export const AGY_GEMINI_GROUP = "Gemini Models";

export interface AgyUsageWindow {
  /** 使用率 % (0〜100)。 */
  usedPct: number;
  /** リセット時刻 (epoch 秒)。 読めなければ null。 */
  resetsAtSec: number | null;
}

export interface AgyUsageRow extends AgyUsageWindow {
  group: string;
  label: string;
  window: "weekly" | "fiveHour" | "other";
}

export interface AgyUsage {
  /** Gemini Models の 5H 枠。 */
  fiveHour: AgyUsageWindow | null;
  /** Gemini Models の週間枠。 */
  weekly: AgyUsageWindow | null;
  /** Gemini Models 以外の枠 (Claude and GPT models、モデル別の週間枠など)。 */
  others: AgyUsageRow[];
  /** 取得した時刻 (epoch ms)。 */
  fetchedAt: number;
}

const PERCENT = /^(\d+(?:\.\d+)?)%$/;

export function parseAgyUsageOutput(stdout: string, fetchedAt: number): AgyUsage | null {
  const rows = stdout.split(/\r?\n/).map(parseRow).filter((row): row is AgyUsageRow => row !== null);
  if (rows.length === 0) return null;
  const gemini = rows.filter((row) => row.group === AGY_GEMINI_GROUP);
  const pick = (window: AgyUsageRow["window"]): AgyUsageWindow | null => {
    const row = gemini.find((r) => r.window === window);
    return row ? { usedPct: row.usedPct, resetsAtSec: row.resetsAtSec } : null;
  };
  return {
    fiveHour: pick("fiveHour"),
    weekly: pick("weekly"),
    others: rows.filter((row) => row.group !== AGY_GEMINI_GROUP),
    fetchedAt,
  };
}

function parseRow(line: string): AgyUsageRow | null {
  const cells = line.split("\t").map((cell) => cell.trim());
  if (cells.length < 3) return null;
  const [group, label, percent, reset] = cells;
  if (!group || !label) return null;
  const match = PERCENT.exec(percent ?? "");
  if (!match) return null;
  const remaining = Number(match[1]);
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) return null;
  return {
    group,
    label,
    window: windowOf(label),
    usedPct: round1(100 - remaining),
    resetsAtSec: parseResetSec(reset),
  };
}

function windowOf(label: string): AgyUsageRow["window"] {
  if (/weekly/i.test(label)) return "weekly";
  if (/five\s*hour|5\s*h/i.test(label)) return "fiveHour";
  return "other";
}

function parseResetSec(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
