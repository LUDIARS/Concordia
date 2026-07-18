import { eventBus, type ConcordiaEvent } from "../events.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ChatPlatformPost } from "../platform/chat-platform.js";
import type { SessionEventRow } from "../shared/types.js";
import { isTranscriptCompletion } from "../platform/transcript-completion.js";
import { parseRequesterSource, type Requester } from "./requester.js";

export interface IdleNudgeTimerHandle {
  unref?: () => void;
}

export interface IdleNudgeTimerApi<THandle extends IdleNudgeTimerHandle = IdleNudgeTimerHandle> {
  setTimeout(callback: () => void, ms: number): THandle;
  clearTimeout(handle: THandle): void;
}

export interface IdleNudgeOptions<THandle extends IdleNudgeTimerHandle = IdleNudgeTimerHandle> {
  seconds: number;
  notify: (sessionId: string) => void | Promise<void>;
  timers?: IdleNudgeTimerApi<THandle>;
  keepTimersRefed?: boolean;
  log?: { warn: (message: string) => void };
}

export interface IdleNudgeHandle {
  arm(sessionId: string): void;
  clear(sessionId: string): void;
  dispose(): void;
}

interface IdleNudgeEntry<THandle extends IdleNudgeTimerHandle> {
  timer: THandle;
  armedAt: number;
}

const defaultTimers: IdleNudgeTimerApi<ReturnType<typeof setTimeout>> = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export function createIdleNudge<THandle extends IdleNudgeTimerHandle = ReturnType<typeof setTimeout>>(
  opts: IdleNudgeOptions<THandle>,
): IdleNudgeHandle {
  const seconds = Math.floor(opts.seconds);
  const timers = (opts.timers ?? defaultTimers) as IdleNudgeTimerApi<THandle>;
  const shouldUnrefTimers = !opts.keepTimersRefed;
  const entries = new Map<string, IdleNudgeEntry<THandle>>();

  function clear(sessionId: string): void {
    const current = entries.get(sessionId);
    if (!current) return;
    timers.clearTimeout(current.timer);
    entries.delete(sessionId);
  }

  function fire(sessionId: string): void {
    entries.delete(sessionId);
    void Promise.resolve(opts.notify(sessionId)).catch((err) => {
      opts.log?.warn(`idle nudge notify failed session=${sessionId}: ${(err as Error).message}`);
    });
  }

  return {
    arm(sessionId) {
      if (seconds <= 0) return;
      clear(sessionId);
      const timer = timers.setTimeout(() => fire(sessionId), seconds * 1000);
      if (shouldUnrefTimers) timer.unref?.();
      entries.set(sessionId, { timer, armedAt: Date.now() });
    },
    clear,
    dispose() {
      for (const id of Array.from(entries.keys())) clear(id);
    },
  };
}

export function collectIdleNudgeRequesters(events: readonly SessionEventRow[]): Requester[] {
  const seen = new Set<string>();
  const requesters: Requester[] = [];
  for (const ev of events) {
    if (ev.kind !== "inject") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(ev.payload);
    } catch {
      continue;
    }
    const source = payload && typeof payload === "object"
      ? (payload as { source?: unknown }).source
      : null;
    const requester = parseRequesterSource(source);
    if (!requester) continue;
    const key = `${requester.platform}:${requester.userId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requesters.push(requester);
  }
  return requesters;
}

export function buildIdleNudgeText(requesters: readonly Requester[], seconds: number): string {
  const mentionPrefix = requesters.map((r) => `<@${r.userId}>`).join(" ");
  const body = `This session has been waiting for input for ${Math.floor(seconds)} seconds after its last answer. Still waiting.`;
  return mentionPrefix ? `${mentionPrefix} ${body}` : body;
}

export interface IdleNudgeNotifyDeps {
  listEvents(sessionId: string): SessionEventRow[];
  isActiveSession(sessionId: string): boolean;
  postToSession(input: ChatPlatformPost): Promise<void>;
  seconds: number;
}

export async function notifyIdleNudge(deps: IdleNudgeNotifyDeps, sessionId: string): Promise<void> {
  if (!deps.isActiveSession(sessionId)) return;
  const requesters = collectIdleNudgeRequesters(deps.listEvents(sessionId));
  if (requesters.length === 0) return;
  await deps.postToSession({
    sessionId,
    text: buildIdleNudgeText(requesters, deps.seconds),
    authorLabel: "Concordia",
  });
}

export interface StartIdleNudgeOptions {
  repo: SessionsRepo;
  seconds: number;
  postToSession(input: ChatPlatformPost): Promise<void>;
  keepTimersRefed?: boolean;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

export interface StartIdleNudgeHandle {
  stop(): void;
}

export function startIdleNudge(opts: StartIdleNudgeOptions): StartIdleNudgeHandle {
  const enabled = Math.floor(opts.seconds) > 0;
  const isActiveSession = (sessionId: string): boolean =>
    opts.repo.findSession(sessionId)?.status === "active";
  const idle = createIdleNudge({
    seconds: opts.seconds,
    keepTimersRefed: opts.keepTimersRefed,
    log: opts.log,
    notify: (sessionId) =>
      notifyIdleNudge({
        listEvents: (id) => opts.repo.eventsByKind(id, "inject"),
        isActiveSession,
        postToSession: opts.postToSession,
        seconds: opts.seconds,
      }, sessionId),
  });

  const unsubscribe = eventBus.subscribe((ev) => {
    if (!enabled) return;
    handleIdleNudgeEvent(idle, isActiveSession, ev);
  });
  opts.log?.info(enabled
    ? `idle nudge started (${Math.floor(opts.seconds)}s)`
    : "idle nudge disabled");

  return {
    stop() {
      unsubscribe();
      idle.dispose();
    },
  };
}

export function shouldArmIdleNudgeFromFrame(ev: Extract<ConcordiaEvent, { type: "transcript.frame" }>): boolean {
  return isTranscriptCompletion(ev.kind, ev.payload);
}

export function shouldClearIdleNudgeFromFrame(ev: Extract<ConcordiaEvent, { type: "transcript.frame" }>): boolean {
  if (ev.kind !== "text") return false;
  const payload = ev.payload as { role?: unknown } | null | undefined;
  return payload?.role === "user";
}

function handleIdleNudgeEvent(
  idle: IdleNudgeHandle,
  isActiveSession: (sessionId: string) => boolean,
  ev: ConcordiaEvent,
): void {
  if (ev.type === "transcript.frame") {
    if (shouldClearIdleNudgeFromFrame(ev)) {
      idle.clear(ev.target_session_id);
      return;
    }
    if (shouldArmIdleNudgeFromFrame(ev) && isActiveSession(ev.target_session_id)) {
      idle.arm(ev.target_session_id);
    }
    return;
  }
  if (ev.type === "session.inject") {
    if (parseRequesterSource(ev.source)) idle.clear(ev.target_session_id);
    return;
  }
  if (ev.type === "session.event" && ev.kind === "user_activity") {
    idle.clear(ev.session_id);
    return;
  }
  if (ev.type === "session.ended" || ev.type === "session.lost") {
    idle.clear(ev.session_id);
  }
}
