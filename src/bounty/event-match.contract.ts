/** @implements SPEC-BOUNTY-EVENT */
/**
 * C-1: a report is linked only to an event that is open at intake time and whose target projects and intake
 * channels contain the report's project code and intake platform. A report with no project, or with no
 * candidate, gets no event (the intake continues). An explicit event id that is not a candidate is refused
 * with `event_not_applicable` (spec/feature/bug-bounty.md §0 §18.2, CC-BOUNTY-INV-11).
 */
interface EventLike {
  id?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  endedEarlyAt?: unknown;
  projects?: unknown;
  channels?: unknown;
}

function isCandidate(event: EventLike, project: string, platform: unknown, now: number): boolean {
  if (typeof event.startsAt !== "number" || typeof event.endsAt !== "number") return false;
  const end = typeof event.endedEarlyAt === "number" ? Math.min(event.endsAt, event.endedEarlyAt) : event.endsAt;
  return event.startsAt <= now && now < end
    && Array.isArray(event.projects) && event.projects.includes(project)
    && Array.isArray(event.channels) && event.channels.includes(platform);
}

export default {
  post(
    result: unknown,
    input: {
      events?: readonly EventLike[];
      project?: unknown;
      platform?: unknown;
      eventId?: unknown;
      now?: unknown;
    } | undefined,
  ): boolean {
    if (!result || typeof result !== "object" || !input || typeof input.now !== "number") return false;
    const outcome = result as { ok?: unknown; event?: EventLike | null; error?: unknown };
    const project = typeof input.project === "string" ? input.project : null;
    const candidates = project === null
      ? []
      : (input.events ?? []).filter((event) => isCandidate(event, project, input.platform, input.now as number));
    const requested = typeof input.eventId === "string" && input.eventId !== "" ? input.eventId : null;
    if (outcome.ok !== true) {
      return outcome.error === "event_not_applicable" && requested !== null
        && !candidates.some((event) => event.id === requested);
    }
    if (outcome.event === null) return requested === null && candidates.length === 0;
    if (!outcome.event) return false;
    const linked = outcome.event;
    if (!candidates.some((event) => event.id === linked.id)) return false;
    return requested === null || linked.id === requested;
  },
};
