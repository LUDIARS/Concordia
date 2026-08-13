/**
 * Discord slash command とワークフローの対応、 およびフラグ変化に応じた再登録。
 *
 * @implements spec/tasks/workflow-toggles.md — W1-2 / W6
 *
 * 無効なワークフローのコマンドは guild へ **登録しない**。 「登録したまま実行時に
 * 断る」 のではなく、 コマンド一覧から消す。 フラグは都度解決なので、 変化を検知して
 * 登録内容を張り替える watcher もここに置く。
 */

import type { WorkflowKey } from "../workflow/keys.js";
import { WORKFLOW_KEYS } from "../workflow/keys.js";

/**
 * コマンド名 → 所属ワークフロー。 ここに無いコマンドはセッションコントロール基盤の
 * 一部とみなし、 ワークフローが全部無効でも登録し続ける。
 */
const COMMAND_WORKFLOWS: Record<string, WorkflowKey> = {
  mmtask: "task",
  confirm: "test",
  prs: "review",
  "rv-prs": "review",
};

export function workflowForCommand(name: string): WorkflowKey | null {
  return COMMAND_WORKFLOWS[name] ?? null;
}

/** そのコマンドを guild に登録してよいか。 */
export function isCommandWorkflowEnabled(
  name: string,
  isEnabled: (key: WorkflowKey) => boolean,
): boolean {
  const key = workflowForCommand(name);
  return key === null ? true : isEnabled(key);
}

/**
 * 現在の有効/無効の組み合わせを表す文字列。 これが変わったときだけ再登録する
 * (毎 tick REST を叩かないため)。
 */
export function workflowCommandSignature(isEnabled: (key: WorkflowKey) => boolean): string {
  return WORKFLOW_KEYS.map((key) => `${key}=${isEnabled(key) ? "1" : "0"}`).join(",");
}

export const COMMAND_REGISTRATION_CHECK_MS = 15_000;

export interface CommandRegistrationWatchDeps {
  /** 現在の signature を都度解決する。 */
  signature: () => string;
  /** signature が変わったときに呼ばれる再登録処理。 */
  reregister: () => Promise<void>;
  intervalMs?: number;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

export interface CommandRegistrationWatchHandle {
  stop: () => void;
  /** テスト用: tick を明示的に 1 回進める。 */
  tick: () => Promise<void>;
}

export function startCommandRegistrationWatch(
  deps: CommandRegistrationWatchDeps,
): CommandRegistrationWatchHandle {
  let lastSignature = deps.signature();
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return;
    const current = deps.signature();
    if (current === lastSignature) return;
    inFlight = true;
    try {
      await deps.reregister();
      lastSignature = current;
      deps.log.info(`slash commands re-registered for workflow change signature=${current}`);
    } catch (error) {
      // signature は更新しない = 次の tick で再試行する。
      deps.log.warn(`slash command re-registration failed: ${(error as Error).message}`);
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? COMMAND_REGISTRATION_CHECK_MS);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    tick,
  };
}
