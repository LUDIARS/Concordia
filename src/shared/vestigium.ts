/**
 * Vestigium (Vg) ログ統合 — Concordia のハーネス/協調イベントを LUDIARS 横断ログ収集 SDK
 * (@ludiars/vestigium) の JSONL へ流す。 Concordia 自身の monitor (file-tail / error-detector /
 * MCP) が同じ logsDir を読むので、 ここに出した harness ログは横断観測・AI への提供対象になる。
 *
 * 方針:
 *  - install() を 1 回だけ行い、 writer を共有する。 captureConsole=true で stray な console.error
 *    (監査書込失敗の surface 等) も拾う。 pino パイプラインは触らず、 構造化イベントは vgWrite で明示。
 *  - logsDir は Vestigium 既定 (env VESTIGIUM_LOGS_DIR > cwd/logs)。 横断集約は env で共有ルートを指す。
 *  - **ctx に機微情報 (token / PII / コマンド/プロンプトの生データ) を入れない** (Vestigium CLAUDE.md
 *    のルール)。 メタデータ (tool / rule / decision / repo / branch 等) のみ渡す。
 *  - test (NODE_ENV=test / VITEST) と CONCORDIA_VESTIGIUM=0 では無効 (ファイル書込/ハンドル汚染回避)。
 */

import { install, type Vestigium } from "@ludiars/vestigium";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("vestigium");

const DISABLED =
  process.env.CONCORDIA_VESTIGIUM === "0" ||
  process.env.NODE_ENV === "test" ||
  process.env.VITEST === "true";

let vg: Vestigium | null = null;
if (!DISABLED) {
  try {
    vg = install({
      serviceCode: "concordia",
      captureConsole: true,
      retentionDays: Number(process.env.VESTIGIUM_RETENTION_DAYS ?? "14") || 14,
    });
  } catch (e) {
    // install 失敗 (権限/パス等) は Vg ログを諦めるが本体は止めない。 理由は残す。
    log.warn({ err: (e as Error).message }, "vestigium install failed; Vg ログは無効");
  }
}

export type VgLevel = "trace" | "debug" | "info" | "warn" | "error";

/**
 * Vg JSONL へ 1 行 emit。 失敗してもログで本体を止めない (never throw)。
 * ctx には機微情報を入れないこと (token / PII / コマンド・プロンプトの生データは禁止)。
 */
export function vgWrite(level: VgLevel, msg: string, ctx?: Record<string, unknown>): void {
  try { vg?.writer.write({ level, msg, ctx }); } catch { /* never throw from logging */ }
}

export function vgEnabled(): boolean { return vg !== null; }

/** プロセス終了時に writer/sweeper を畳む (任意。 呼ばなくても sweeper は unref 済)。 */
export async function vgShutdown(): Promise<void> {
  try { await vg?.shutdown(); } catch { /* swallow */ }
  vg = null;
}
