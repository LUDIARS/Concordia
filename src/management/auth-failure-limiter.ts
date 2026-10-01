/**
 * 送信元ごとの認証失敗の数え上げ (CC-MGMT-07)。 窓内の失敗が上限に達した送信元は、
 * 窓が明けるまでトークン照合をせずに 429 で断る。
 */
export class AuthFailureLimiter {
  private readonly failures = new Map<string, { count: number; windowStartMs: number }>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isLimited(remote: string): boolean {
    const entry = this.failures.get(remote);
    if (!entry) return false;
    if (this.now() - entry.windowStartMs > this.windowMs) {
      this.failures.delete(remote);
      return false;
    }
    return entry.count >= this.limit;
  }

  recordFailure(remote: string): void {
    const now = this.now();
    const entry = this.failures.get(remote);
    if (!entry || now - entry.windowStartMs > this.windowMs) {
      this.failures.set(remote, { count: 1, windowStartMs: now });
      return;
    }
    entry.count += 1;
  }

  /** 期限切れの記録を捨てる (送信元が入れ替わり続けても溜めない)。 */
  prune(): void {
    const now = this.now();
    for (const [remote, entry] of this.failures) {
      if (now - entry.windowStartMs > this.windowMs) this.failures.delete(remote);
    }
  }
}
