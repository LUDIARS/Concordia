import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eventBus } from "../events.js";
import { injectTestingNotice, TESTING_INJECT_SOURCE } from "./notify.js";
import type { SessionsRepo } from "../db/sessions-repo.js";

type AppendEventInput = { session_id: string; ts: number; kind: string; payload: object };

function makeRepo(appendEvent?: (input: AppendEventInput) => void): SessionsRepo {
  return {
    appendEvent: appendEvent ?? (() => {}),
  } as unknown as SessionsRepo;
}

describe("injectTestingNotice", () => {
  let received: Array<Record<string, unknown>> = [];
  let unsub: (() => void) | null = null;

  beforeEach(() => {
    received = [];
    unsub = eventBus.subscribe((ev) => received.push(ev as Record<string, unknown>));
  });
  afterEach(() => {
    unsub?.();
    unsub = null;
  });

  function injected(): Array<Record<string, unknown>> {
    return received.filter((e) => e.type === "session.inject");
  }

  it("session.inject の emit 形状が正しい (payload 構造検証)", () => {
    const repo = makeRepo();

    injectTestingNotice(repo, "sess-1", "test message");

    const evs = injected();
    expect(evs).toHaveLength(1);
    const ev = evs[0]!;
    expect(ev.type).toBe("session.inject");
    expect(ev.target_session_id).toBe("sess-1");
    expect(ev.text).toBe("test message");
    expect(ev.source).toBe(TESTING_INJECT_SOURCE);
    expect(typeof ev.ts).toBe("number");
    expect(ev.ts).toBeGreaterThan(0);
  });

  it("repo.appendEvent に kind=inject イベントを記録する", () => {
    const appended: AppendEventInput[] = [];
    const repo = makeRepo((input) => appended.push(input));

    injectTestingNotice(repo, "sess-2", "hello");

    expect(appended).toHaveLength(1);
    const row = appended[0]!;
    expect(row.session_id).toBe("sess-2");
    expect(row.kind).toBe("inject");
    const p = row.payload as { text: string; source: string };
    expect(p.text).toBe("hello");
    expect(p.source).toBe(TESTING_INJECT_SOURCE);
  });

  it("repo.appendEvent が例外を投げても eventBus emit は実行される (best-effort 記録)", () => {
    const repo = makeRepo(() => {
      throw new Error("db write failed");
    });

    // 例外を握り潰して eventBus へは必ず届く
    injectTestingNotice(repo, "sess-3", "resilient");

    const evs = injected();
    expect(evs).toHaveLength(1);
    expect(evs[0]!.target_session_id).toBe("sess-3");
    expect(evs[0]!.text).toBe("resilient");
  });
});
