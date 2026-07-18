import type { SlackSessionChannelsRepo } from "./session-channels-repo.js";

export interface SlackArchiveClient {
  conversations: {
    archive(args: { channel: string }): Promise<{ ok?: boolean }>;
  };
}

export interface SlackSessionArchiveDeps {
  repo: SlackSessionChannelsRepo;
  client: SlackArchiveClient;
  delaySeconds: number;
  sweepIntervalMs?: number;
  now?: () => number;
  onArchived?: (sessionId: string) => void | Promise<void>;
  log?: { info: (message: string) => void; warn: (message: string) => void };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/** Owns the single archive timer and retries failed Slack archives on later sweeps. */
export class SlackSessionArchiveLifecycle {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: SlackSessionArchiveDeps) {
    if (!Number.isFinite(deps.delaySeconds) || deps.delaySeconds < 0) {
      throw new Error("Slack archive delaySeconds must be a non-negative finite number");
    }
  }

  async start(): Promise<void> {
    if (this.timer || this.stopped) return;
    const setTimer = this.deps.setIntervalFn ?? setInterval;
    this.timer = setTimer(() => { void this.sweep(); }, this.deps.sweepIntervalMs ?? 60_000);
    this.timer.unref?.();
    await this.sweep();
  }

  async schedule(sessionId: string): Promise<void> {
    const now = this.now();
    this.deps.repo.scheduleArchive(sessionId, now + this.deps.delaySeconds);
    if (this.deps.delaySeconds === 0) await this.sweep();
  }

  /**
   * 予約済み archive を取り消す。 session が再開された (session.started が同じ
   * session_id で再度届いた) ときに呼ぶ想定: session.ended → schedule() で archive
   * 予約が立った後、 archived_at が付く前に再開されたら、 このキャンセルをしないと
   * 次の sweep でアクティブなチャンネルが誤って archive されてしまう。
   */
  cancel(sessionId: string): void {
    this.deps.repo.cancelArchive(sessionId);
  }

  sweep(): Promise<void> {
    if (this.sweepInFlight) return this.sweepInFlight;
    const task = this.runSweep().finally(() => { this.sweepInFlight = null; });
    this.sweepInFlight = task;
    return task;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      (this.deps.clearIntervalFn ?? clearInterval)(this.timer);
      this.timer = null;
    }
    await this.sweepInFlight;
  }

  private async runSweep(): Promise<void> {
    for (const row of this.deps.repo.listDueForArchive(this.now())) {
      try {
        const result = await this.deps.client.conversations.archive({ channel: row.channel_id });
        if (result.ok === false) throw new Error("conversations.archive returned ok=false");
        const archivedAt = this.now();
        this.deps.repo.markArchived(row.session_id, archivedAt);
        this.deps.log?.info(`Slack session channel archived session=${row.session_id} channel=${row.channel_id}`);
        await this.deps.onArchived?.(row.session_id);
      } catch (error) {
        this.deps.log?.warn(
          `Slack session channel archive failed; retry scheduled session=${row.session_id} channel=${row.channel_id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }
}
