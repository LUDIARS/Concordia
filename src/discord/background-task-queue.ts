export interface BackgroundTaskQueueLogger {
  info: (m: string) => void;
  warn: (m: string) => void;
}

export interface BackgroundTaskQueueOptions {
  name: string;
  log: BackgroundTaskQueueLogger;
  now?: () => number;
  /**
   * キュー深さの上限。 超過時は先頭側の droppable なタスクを 1 つ捨ててから積む
   * (droppable が無ければ警告しつつ積む — 重要タスクは決して落とさない)。
   * 0 / 未指定で無制限 (従来挙動)。
   */
  maxDepth?: number;
  /**
   * per-task ログ (enqueued / start / done) を出すか。 既定 true (従来挙動 =
   * verbose-logging-bootstrap)。 false でも 失敗 / drop / depth 節目 / 低速タスク
   * は引き続き出す。 運用では CONCORDIA_QUEUE_VERBOSE=0 → false を想定。
   */
  verbose?: boolean;
}

interface QueuedTask {
  id: number;
  label: string;
  task: () => Promise<void> | void;
  queuedAt: number;
  droppable: boolean;
}

export interface EnqueueOptions {
  /** 溢れ時に捨ててよいタスク (transcript.frame relay 等の損失許容なもの)。 */
  droppable?: boolean;
}

export interface BackgroundTaskQueueStats {
  depth: number;
  processed: number;
  dropped: number;
}

/** 静音時でも depth がこの倍数を跨いだら info を出す (詰まりの検知)。 */
const DEPTH_MILESTONE = 100;
/** 静音時でも これ以上待った / かかった タスクは info を出す。 */
const SLOW_WAIT_MS = 5_000;
const SLOW_TASK_MS = 2_000;
/** drop 警告のレート制限窓。 窓内の drop はまとめて 1 行にする。 */
const DROP_WARN_WINDOW_MS = 10_000;

export class BackgroundTaskQueue {
  private readonly queue: QueuedTask[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private nextId = 1;
  private running = false;
  private stopped = false;
  private processed = 0;
  private dropped = 0;
  private lastDropWarnAt = 0;
  private droppedSinceWarn = 0;
  private lastMilestone = 0;

  constructor(private readonly options: BackgroundTaskQueueOptions) {}

  enqueue(label: string, task: () => Promise<void> | void, opts?: EnqueueOptions): number {
    if (this.stopped) {
      this.options.log.warn(`${this.options.name} queue rejected after stop: ${label}`);
      return -1;
    }
    const id = this.nextId++;
    this.evictIfOverflowing(label);
    this.queue.push({ id, label, task, queuedAt: this.now(), droppable: opts?.droppable === true });
    this.logEnqueued(id, label);
    void this.drain();
    return id;
  }

  enqueueDelayed(label: string, delayMs: number, task: () => Promise<void> | void, opts?: EnqueueOptions): number {
    if (this.stopped) {
      this.options.log.warn(`${this.options.name} queue delayed task rejected after stop: ${label}`);
      return -1;
    }
    const id = this.nextId++;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.stopped) return;
      this.evictIfOverflowing(label);
      this.queue.push({ id, label, task, queuedAt: this.now(), droppable: opts?.droppable === true });
      this.logEnqueued(id, label);
      void this.drain();
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.timers.add(timer);
    if (this.verbose()) {
      this.options.log.info(`${this.options.name} queue scheduled #${id} ${label} delay_ms=${Math.max(0, delayMs)}`);
    }
    return id;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.queue.length = 0;
  }

  stats(): BackgroundTaskQueueStats {
    return { depth: this.queue.length, processed: this.processed, dropped: this.dropped };
  }

  /**
   * maxDepth 超過時に先頭側 (最古) の droppable タスクを 1 つ捨てる。
   * 古い transcript relay より新しいものを残す方が価値が高いため先頭側から捨てる。
   * droppable が 1 つも無ければ捨てずに積む (重要タスク保護) — その場合も警告する。
   */
  private evictIfOverflowing(incomingLabel: string): void {
    const maxDepth = this.options.maxDepth ?? 0;
    if (maxDepth <= 0 || this.queue.length < maxDepth) return;
    const idx = this.queue.findIndex((t) => t.droppable);
    if (idx >= 0) {
      const [victim] = this.queue.splice(idx, 1);
      this.dropped += 1;
      this.warnDrop(`dropped #${victim!.id} ${victim!.label} (depth=${this.queue.length + 1} max=${maxDepth}, incoming: ${incomingLabel})`);
    } else {
      this.warnDrop(`over maxDepth=${maxDepth} but no droppable task — growing (incoming: ${incomingLabel})`);
    }
  }

  private warnDrop(detail: string): void {
    this.droppedSinceWarn += 1;
    const now = this.now();
    if (now - this.lastDropWarnAt < DROP_WARN_WINDOW_MS) return;
    const suppressed = this.droppedSinceWarn - 1;
    this.lastDropWarnAt = now;
    this.droppedSinceWarn = 0;
    this.options.log.warn(
      `${this.options.name} queue overflow: ${detail}` +
      (suppressed > 0 ? ` (+${suppressed} in last ${DROP_WARN_WINDOW_MS / 1000}s)` : ""),
    );
  }

  private logEnqueued(id: number, label: string): void {
    if (this.verbose()) {
      this.options.log.info(`${this.options.name} queue enqueued #${id} ${label} depth=${this.queue.length}`);
      return;
    }
    // 静音時も詰まりは可視化する: depth が節目 (100, 200, …) を跨いだ時だけ出す。
    const milestone = Math.floor(this.queue.length / DEPTH_MILESTONE);
    if (milestone > this.lastMilestone) {
      this.options.log.info(`${this.options.name} queue depth=${this.queue.length} (milestone, latest: ${label})`);
    }
    this.lastMilestone = milestone;
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const item = this.queue.shift();
        if (!item) return;
        const waitedMs = this.now() - item.queuedAt;
        if (this.verbose() || waitedMs >= SLOW_WAIT_MS) {
          this.options.log.info(`${this.options.name} queue start #${item.id} ${item.label} waited_ms=${waitedMs} remaining=${this.queue.length}`);
        }
        const startedAt = this.now();
        try {
          await item.task();
          this.processed += 1;
          const durationMs = this.now() - startedAt;
          if (this.verbose() || durationMs >= SLOW_TASK_MS) {
            this.options.log.info(`${this.options.name} queue done #${item.id} ${item.label} duration_ms=${durationMs}`);
          }
        } catch (err) {
          this.options.log.warn(`${this.options.name} queue failed #${item.id} ${item.label} duration_ms=${this.now() - startedAt}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
      if (!this.stopped && this.queue.length > 0) void this.drain();
    }
  }

  private verbose(): boolean {
    return this.options.verbose !== false;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export const discordCommandQueue = new BackgroundTaskQueue({
  name: "discord-command",
  log: consoleQueueLogger("discord-command"),
});

function consoleQueueLogger(name: string): BackgroundTaskQueueLogger {
  return {
    info: (m) => console.info(`[${name}] ${m}`),
    warn: (m) => console.warn(`[${name}] ${m}`),
  };
}
