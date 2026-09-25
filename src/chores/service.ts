import type { ChoresRepository } from "./repository.js";
import { canChooseChore, CHORE_TIMEOUT_MS, validateChoreInput, type Chore, type ChoreProvider } from "./domain.js";

export interface ChorePorts {
  now: () => number;
  id: () => string;
  cwd: (id: string) => string;
  isBlocked: () => boolean;
  execute: (run: Chore, signal: AbortSignal) => Promise<{ ok: boolean; output: string; error: string | null }>;
  continue: (run: Chore) => Promise<{ ok: true } | { ok: false; error: string }>;
  logError: (error: unknown) => void;
}

/** Application owner: persists intent before each external side effect. */
export class ChoresService {
  private stopping = false;
  private active: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private readonly continuations = new Set<Promise<Chore>>();
  constructor(readonly repo: ChoresRepository, private readonly ports: ChorePorts) {}

  submit(requestKey: string, prompt: string, provider: ChoreProvider): Chore {
    if (this.stopping) throw new Error("雑務の受付を停止しています。");
    validateChoreInput(prompt, provider);
    const existing = this.repo.byRequest(requestKey);
    if (existing) {
      if (existing.prompt !== prompt || existing.provider !== provider) throw new Error("受付キーが別の依頼で使用されています。");
      return existing;
    }
    if (this.ports.isBlocked()) throw new Error("コスト上限のため新規実行を停止しています。");
    const id = this.ports.id();
    const now = this.ports.now();
    return this.repo.enqueue({ id, request_key: requestKey, prompt, provider, status: "queued", cwd: this.ports.cwd(id),
      output: "", error: null, spawn_id: null, created_at: now, updated_at: now, revision: 1,
      delivered_revision: 0, discord_message_id: null });
  }

  tick(): void {
    if (this.stopping || this.active) return;
    // Timeout includes a grace period for killing and persisting the owned child.
    this.repo.expireBefore(this.ports.now() - CHORE_TIMEOUT_MS - 60_000, this.ports.now());
    if (this.ports.isBlocked()) return;
    const row = this.repo.claim(this.ports.now());
    if (!row) return;
    this.abort = new AbortController();
    this.active = this.runClaimedChore(row, this.abort.signal).catch(this.ports.logError).finally(() => {
      this.active = null;
      this.abort = null;
    });
  }
  private async runClaimedChore(row: Chore, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.ports.execute(row, signal);
      this.repo.transition(row, result.ok ? "succeeded" : "failed", this.ports.now(), { output: result.output, error: result.error });
    } catch (error) {
      this.repo.transition(row, "failed", this.ports.now(), { error: error instanceof Error ? error.message : String(error) });
    }
  }
  choose(id: string, action: "ok" | "continue"): Promise<Chore> {
    const pending = this.chooseOnce(id, action);
    this.continuations.add(pending);
    void pending.then(() => this.continuations.delete(pending), () => this.continuations.delete(pending));
    return pending;
  }
  private async chooseOnce(id: string, action: "ok" | "continue"): Promise<Chore> {
    if (this.stopping) throw new Error("雑務の受付を停止しています。");
    const row = this.repo.find(id);
    if (!row) throw new Error("雑務が見つかりません。");
    if (!canChooseChore(row.status, action)) return row;
    if (action === "continue" && this.ports.isBlocked()) throw new Error("コスト上限のため継続起動を停止しています。");
    const next = this.repo.transition(row, action === "ok" ? "acknowledged" : "continuing", this.ports.now(),
      action === "continue" ? { spawn_id: this.ports.id() } : {});
    if (!next) return this.repo.find(id) ?? row;
    if (action === "ok") return next;
    try {
      const result = await this.ports.continue(next);
      return this.repo.transition(next, result.ok ? "continued" : row.status, this.ports.now(),
        result.ok ? { error: null } : { error: result.error, spawn_id: null }) ?? next;
    } catch (error) {
      // A thrown error can mean spawn succeeded but its acknowledgement was lost.
      this.ports.logError(error);
      return this.repo.transition(next, "continuing", this.ports.now(), { error: "継続起動の結果が不明です。起動IDを照合してください。" }) ?? next;
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort?.abort();
    await this.active;
    await Promise.allSettled([...this.continuations]);
  }
}
