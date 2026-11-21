import { breakerReason, canCooldown, formatBreakerAlert, type BreakerConfig, type BreakerTarget } from "./circuit-breaker.js";
import type { BreakerSnapshot, CircuitBreakerRepository } from "./circuit-breaker-repo.js";

interface BreakerPorts {
  now: () => number;
  isCostBlocked: () => boolean;
  countManagedRuns: () => number;
  postAlert: (text: string) => Promise<boolean>;
  sessionLink: (sessionId: string) => string | null;
}

type ExternalError = "run_id_conflict" | "run_already_finished" | "run_not_found";
type ExternalResult = { breaker: BreakerSnapshot } | { error: ExternalError };

export class CircuitBreakerService {
  private alertInFlight: Promise<void> | null = null;

  constructor(private readonly repo: CircuitBreakerRepository, private readonly ports: BreakerPorts) {}

  snapshot(): BreakerSnapshot {
    return this.repo.transaction(() => this.readCurrent(this.ports.now()));
  }

  check(runId: string, target: BreakerTarget): ExternalResult {
    return this.repo.transaction(() => {
      const now = this.ports.now();
      const state = this.readCurrent(now);
      if (state.status === "OPEN") return { breaker: state };
      const existing = this.repo.startOf(runId);
      if (existing) {
        if (existing.project_code !== target.project_code || existing.target_key !== target.target_key) return { error: "run_id_conflict" };
        if (this.repo.resultOf(runId)) return { error: "run_already_finished" };
        return { breaker: state };
      }
      const breaker = this.checkStart(target, state, now);
      if (breaker.status === "CLOSED") this.repo.recordStart("external_start", target, now, runId);
      return { breaker };
    });
  }

  admitManaged<T>(target: BreakerTarget, claim: () => T | null): T | null {
    return this.repo.transaction(() => {
      const now = this.ports.now();
      if (this.checkStart(target, this.readCurrent(now), now).status === "OPEN") return null;
      const claimed = claim();
      if (claimed !== null) this.repo.recordStart("managed_start", target, now);
      return claimed;
    });
  }

  report(runId: string, result: "failure" | "success", sessionId: string | null): ExternalResult {
    return this.repo.transaction(() => {
      const target = this.repo.startOf(runId);
      if (!target) return { error: "run_not_found" };
      const prior = this.repo.resultOf(runId);
      if (prior === result) return { breaker: this.readCurrent(this.ports.now()) };
      if (prior) return { error: "run_already_finished" };
      return { breaker: this.recordResult(result, { ...target, session_id: sessionId ?? target.session_id }, runId) };
    });
  }

  recordFailure(target: BreakerTarget): void {
    this.repo.transaction(() => this.recordResult("failure", target));
  }

  recordSuccess(target: BreakerTarget): void {
    this.repo.transaction(() => this.recordResult("success", target));
  }

  trip(target: BreakerTarget | null): BreakerSnapshot {
    return this.repo.transaction(() => {
      this.repo.trip("manual", target, this.ports.now());
      return this.repo.snapshot();
    });
  }

  reset(): BreakerSnapshot {
    return this.repo.transaction(() => {
      this.repo.reset(this.ports.now());
      return this.repo.snapshot();
    });
  }

  configure(patch: Partial<BreakerConfig>): BreakerSnapshot {
    return this.repo.transaction(() => {
      this.repo.updateConfig({ ...this.repo.snapshot().config, ...patch });
      return this.readCurrent(this.ports.now());
    });
  }

  flushAlerts(): Promise<void> {
    this.alertInFlight ??= this.deliverAlert().finally(() => { this.alertInFlight = null; });
    return this.alertInFlight;
  }

  private async deliverAlert(): Promise<void> {
    const alert = this.repo.nextAlert();
    if (!alert) return;
    const link = alert.target?.session_id ? this.ports.sessionLink(alert.target.session_id) : null;
    if (await this.ports.postAlert(formatBreakerAlert(alert.reason, alert.target, link))) {
      this.repo.markAlertDelivered(alert.id, this.ports.now());
    }
  }

  private checkStart(target: BreakerTarget, state: BreakerSnapshot, now: number): BreakerSnapshot {
    if (state.status === "OPEN") return state;
    const reason = breakerReason(state.config, {
      costBlocked: this.ports.isCostBlocked(),
      failures: state.consecutive_failures,
      start: { ...this.repo.startCounts(target, now), active: this.ports.countManagedRuns() + this.repo.activeExternalRuns() },
    });
    if (!reason) return state;
    this.repo.trip(reason, target, now);
    return this.repo.snapshot();
  }

  private recordResult(result: "failure" | "success", target: BreakerTarget, runId?: string): BreakerSnapshot {
    const now = this.ports.now();
    this.readCurrent(now);
    this.repo.recordResult(result, target, now, runId);
    const state = this.repo.snapshot();
    const reason = breakerReason(state.config, { costBlocked: false, failures: state.consecutive_failures, start: null });
    if (reason && state.status === "CLOSED") {
      this.repo.trip(reason, target, now);
      return this.repo.snapshot();
    }
    return state;
  }

  private readCurrent(now: number): BreakerSnapshot {
    const state = this.repo.snapshot();
    if (!canCooldown(state.opened_at, state.config.cooldown_ms, now)) return state;
    this.repo.reset(now);
    return this.repo.snapshot();
  }
}
