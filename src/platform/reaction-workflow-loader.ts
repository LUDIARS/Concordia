/**
 * Reaction-WorkFlow (RWF) プラグインのランタイムローダ。
 *
 * RWF は「ユーザカスタマイズコード」として別リポ (LUDIARS/Concordia-RWF) に切り出した。
 * Concordia コアは起動時にこのローダで **外部プラグインを動的 import** し、 在れば外部を、
 * 無ければ **同梱エンジン (./reaction-workflow.js) にフォールバック**する。
 *  - 外部優先: `CONCORDIA_RWF_PLUGIN_PATH` (既定 `<workspaceRoot>/Concordia-RWF/dist/index.js`)。
 *  - 契約検証: 期待シンボル (ReactionWorkflowRunner / classify / isStandaloneEmoji) が揃うか。
 *  - 失敗時は同梱にフォールバックし、 RWF が止まらないようにする (no-silent-fallback: warn ログを出す)。
 *
 * 型はビルド時に同梱モジュールから取る (外部は構造的に同一)。 実装は getRwf() で実行時解決。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as bundled from "./reaction-workflow.js";

/** RWF プラグインの公開モジュール型 (= 同梱エンジンの型)。 外部もこれに構造一致する前提。 */
export type RwfModule = typeof bundled;

/** 実行時に使うモジュール。 init 前 / フォールバック時は同梱。 */
let active: RwfModule = bundled;
let initialized = false;

/** 外部プラグインが最低限の契約シンボルを備えるか (実行時検証)。 */
function isValidRwfModule(m: unknown): m is RwfModule {
  const o = m as Partial<RwfModule> | null;
  return (
    !!o &&
    typeof (o as RwfModule).ReactionWorkflowRunner === "function" &&
    typeof (o as RwfModule).classifyReactionWorkflow === "function" &&
    typeof (o as RwfModule).isStandaloneEmoji === "function" &&
    typeof (o as RwfModule).reactionAckText === "function"
  );
}

/** 外部プラグイン entry の既定パス (env 優先)。 */
function resolvePluginPath(workspaceRoot: string | null | undefined): string {
  const env = (process.env.CONCORDIA_RWF_PLUGIN_PATH ?? "").trim();
  if (env) return env;
  const root = (workspaceRoot ?? "").trim();
  // <workspaceRoot>/Concordia-RWF/dist/index.js (= ローカル clone のビルド成果物)。
  return root ? join(root, "Concordia-RWF", "dist", "index.js") : "";
}

/**
 * 外部 RWF プラグインを 1 度だけ読み込む (失敗時は同梱フォールバック)。
 * bots を起動する前に await して呼ぶ。 2 度目以降は no-op。
 */
export async function initReactionWorkflow(
  workspaceRoot: string | null | undefined,
  log: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
  if (initialized) return;
  initialized = true;
  const path = resolvePluginPath(workspaceRoot);
  if (!path) {
    log.info("rwf-loader: no plugin path resolved → using bundled engine");
    return;
  }
  if (!existsSync(path)) {
    log.info(`rwf-loader: external plugin not found at ${path} → using bundled engine`);
    return;
  }
  try {
    const mod: unknown = await import(pathToFileURL(path).href);
    if (isValidRwfModule(mod)) {
      active = mod;
      log.info(`rwf-loader: loaded external RWF plugin from ${path}`);
    } else {
      log.warn(`rwf-loader: external plugin at ${path} failed contract check → using bundled engine`);
    }
  } catch (e) {
    log.warn(`rwf-loader: external plugin load failed (${(e as Error).message}) → using bundled engine`);
  }
}

/** 実行時の RWF モジュール (外部 or 同梱)。 init 前は同梱。 */
export function getRwf(): RwfModule {
  return active;
}

/** テスト用: 状態をリセットする。 */
export function _resetReactionWorkflowLoader(): void {
  active = bundled;
  initialized = false;
}
