/** @implements SPEC-BOUNTY-EVENT */
/**
 * C-2: an event draft is refused when the period is empty or reversed, there is no target project, a target
 * code is not registered, there is no intake channel, or a reward override is negative. Editing a started
 * event cannot drop a target project, and an ended event cannot be edited (spec/feature/bug-bounty.md §8.2 §18.3).
 */
interface Draft {
  startsAt?: unknown;
  endsAt?: unknown;
  projects?: unknown;
  channels?: unknown;
  rewardOverride?: unknown;
}

interface Current {
  startsAt: number;
  endsAt: number;
  endedEarlyAt: number | null;
  projects: readonly string[];
}

export default {
  post(
    result: unknown,
    input: { draft?: Draft; current?: Current | null; registeredCodes?: readonly string[]; now?: unknown } | undefined,
  ): boolean {
    if (!result || typeof result !== "object" || !input || typeof input.now !== "number") return false;
    const outcome = result as { ok?: unknown; value?: { startsAt: number; endsAt: number; projects: string[]; channels: string[]; rewardOverride: Record<string, number> | null } };
    const current = input.current ?? null;
    const now = input.now;
    if (current) {
      const end = current.endedEarlyAt === null ? current.endsAt : Math.min(current.endsAt, current.endedEarlyAt);
      if (now >= end) return outcome.ok !== true;
    }
    if (outcome.ok !== true) return true;
    const value = outcome.value;
    if (!value) return false;
    const registered = new Set(input.registeredCodes ?? []);
    const overrides = value.rewardOverride ? Object.values(value.rewardOverride) : [];
    const valid = value.startsAt < value.endsAt
      && value.projects.length > 0 && value.projects.every((code) => registered.has(code))
      && value.channels.length > 0
      && overrides.every((tokens) => Number.isInteger(tokens) && tokens >= 0);
    if (!valid) return false;
    if (current && current.startsAt <= now) {
      return current.projects.every((code) => value.projects.includes(code)) && value.startsAt === current.startsAt;
    }
    return true;
  },
};
