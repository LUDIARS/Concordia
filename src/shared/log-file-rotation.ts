import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/**
 * pino/file の destination は固定パスなので、そのままでは無制限に成長する。
 * 実測で 2026-07-07 作成の cc-live.jsonl が 1.4 GB まで膨らみ、ログが
 * 障害調査に使えなくなった (warn スパムが 94% を占めた)。
 *
 * ここでは **pino が対象ファイルを open する前** に世代交代させる。
 * 稼働中の rename は Windows で open 済み fd を掴んだまま失敗するため、
 * 起動時ローテーションに限定しているのが要点。
 *
 * @implements spec/feature/operational-log-lifecycle.md — bounded cc-live retention
 */

const DEFAULT_MAX_MB = 128;
const DEFAULT_KEEP = 5;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

export interface RotationPolicy {
  /** この閾値以上なら世代交代する。 */
  maxBytes: number;
  /** 保持する退避ファイル数。超えた古い分は消す。 */
  keep: number;
}

/**
 * 既定 128 MiB / 5 世代。 環境変数は正の整数だけ受け付け、それ以外は既定へ落とす。
 *
 * @implements spec/feature/operational-log-lifecycle.md — 保持ポリシー
 */
export function resolveRotationPolicy(): RotationPolicy {
  return {
    maxBytes: positiveIntFromEnv("CONCORDIA_LOG_FILE_MAX_MB", DEFAULT_MAX_MB) * 1024 * 1024,
    keep: positiveIntFromEnv("CONCORDIA_LOG_FILE_KEEP", DEFAULT_KEEP),
  };
}

/** `cc-live.jsonl` → `cc-live` / `.jsonl` (多重拡張子は考慮しない)。 */
function splitName(filePath: string): { stem: string; ext: string } {
  const name = basename(filePath);
  const ext = extname(name);
  return { stem: ext ? name.slice(0, -ext.length) : name, ext };
}

function archiveStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 自分が作った退避ファイルだけに一致させる。 prefix + 拡張子だけで判定すると
 * 拡張子なしパスで `concordia-log.lock` のような無関係ファイルまで一致し、
 * keep 超過分として消してしまう。 稼働中のログ本体は stamp を持たないので除外される。
 */
function archivePattern(filePath: string): RegExp {
  const { stem, ext } = splitName(filePath);
  return new RegExp(`^${escapeRegExp(stem)}\\.\\d{8}-\\d{6}${escapeRegExp(ext)}$`);
}

function pruneArchives(filePath: string, keep: number): void {
  const dir = dirname(filePath);
  const pattern = archivePattern(filePath);
  let archives: Array<{ path: string; mtimeMs: number }>;
  try {
    archives = readdirSync(dir)
      .filter((name) => pattern.test(name))
      .map((name) => {
        const path = join(dir, name);
        try {
          return { path, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null);
  } catch {
    return;
  }
  // 新しい順に keep 件残す。
  archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of archives.slice(keep)) {
    try {
      unlinkSync(stale.path);
    } catch {
      // 別プロセスが掴んでいるだけなので次回起動で回収する。
    }
  }
}

/**
 * 起動時に一度だけ呼ぶ。閾値未満・未存在なら何もしない。
 * 失敗してもログ出力自体は続けたいので、例外は投げず false を返す。
 *
 * @implements spec/feature/operational-log-lifecycle.md — 起動時 rotation
 */
export function rotateLogFileIfOversize(filePath: string, policy: RotationPolicy, now = new Date()): boolean {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    // 未作成なら pino 側の mkdir + create に任せる。
    return false;
  }
  if (size < policy.maxBytes) return false;

  const { stem, ext } = splitName(filePath);
  const archivePath = join(dirname(filePath), `${stem}.${archiveStamp(now)}${ext}`);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    renameSync(filePath, archivePath);
  } catch {
    return false;
  }
  pruneArchives(filePath, policy.keep);
  return true;
}
