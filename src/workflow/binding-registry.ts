/**
 * ワークフローの実体 (イベント購読 / スケジューラ) をフラグに追従させるレジストリ。
 *
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W1-2 / W6
 *
 * 「フラグは OFF なのに購読やタイマーは動き続けている」 を作らないための土台。
 * 無効なワークフローの binding は **start しない**、 有効から無効へ変わったら
 * **stop する**。 フラグ値は都度解決なので、 変化を検知して張り替える役目もここが持つ。
 */

import type { WorkflowKey } from "./keys.js";

export interface WorkflowBindingHandle {
  stop: () => void;
}

export interface WorkflowBinding {
  /** 所属ワークフロー。 このキーが無効な間は start されない。 */
  key: WorkflowKey;
  /** ログ用の識別名 (レジストリ内で一意)。 */
  name: string;
  /** 実体を起動して停止ハンドルを返す。 再 start されうるので毎回新しい実体を作ること。 */
  start: () => WorkflowBindingHandle;
}

export interface WorkflowBindingRegistryDeps {
  isEnabled: (key: WorkflowKey) => boolean;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

/** フラグ変化を拾う間隔。 スケジューラ系の張り替えは秒単位の遅れで十分。 */
export const WORKFLOW_BINDING_CHECK_MS = 5_000;

export class WorkflowBindingRegistry {
  private readonly bindings = new Map<string, WorkflowBinding>();
  private readonly running = new Map<string, WorkflowBindingHandle>();
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: WorkflowBindingRegistryDeps) {}

  register(binding: WorkflowBinding): void {
    if (this.bindings.has(binding.name)) {
      throw new Error(`duplicate workflow binding: ${binding.name}`);
    }
    this.bindings.set(binding.name, binding);
  }

  /** 登録済み binding の稼働状態を現在のフラグ値へ合わせる (冪等)。 */
  sync(): void {
    for (const binding of this.bindings.values()) {
      const shouldRun = this.deps.isEnabled(binding.key);
      const running = this.running.get(binding.name);
      if (shouldRun && !running) this.startBinding(binding);
      else if (!shouldRun && running) this.stopBinding(binding.name, running);
    }
  }

  /** フラグ変化を周期的に拾って張り替える。 */
  startWatching(intervalMs: number = WORKFLOW_BINDING_CHECK_MS): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => this.sync(), intervalMs);
    this.watchTimer.unref?.();
  }

  runningNames(): string[] {
    return [...this.running.keys()];
  }

  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  /** 監視を止め、 稼働中の binding を全て停止する (シャットダウン用)。 */
  stop(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    for (const [name, handle] of [...this.running.entries()].reverse()) {
      this.stopBinding(name, handle);
    }
  }

  private startBinding(binding: WorkflowBinding): void {
    try {
      this.running.set(binding.name, binding.start());
      this.deps.log?.info(`workflow binding started name=${binding.name} workflow=${binding.key}`);
    } catch (error) {
      this.deps.log?.warn(
        `workflow binding start failed name=${binding.name}: ${(error as Error).message}`,
      );
    }
  }

  private stopBinding(name: string, handle: WorkflowBindingHandle): void {
    this.running.delete(name);
    try {
      handle.stop();
      this.deps.log?.info(`workflow binding stopped name=${name}`);
    } catch (error) {
      this.deps.log?.warn(`workflow binding stop failed name=${name}: ${(error as Error).message}`);
    }
  }
}
