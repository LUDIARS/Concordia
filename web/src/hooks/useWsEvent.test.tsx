// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useLiveQuery } from "./useWsEvent.js";
import { wsClient, type ConcordiaEvent } from "../lib/ws-client.js";

it("re-reads the current snapshot after a reconnect even without a matching domain event", async () => {
  const listeners = new Set<(event: ConcordiaEvent) => void>();
  const subscribe = vi.spyOn(wsClient, "onMessage").mockImplementation(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  const load = vi.fn().mockResolvedValueOnce("previous").mockResolvedValueOnce("current");
  const view = renderHook(() => useLiveQuery<string>(load, ["pr.changed"]));
  try {
    await act(async () => {});
    expect(view.result.current.data).toBe("previous");
    await act(async () => {
      for (const receive of listeners) receive({ type: "hello", ts: 1, service: "concordia" });
    });
    expect(view.result.current.data).toBe("current");
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    subscribe.mockRestore();
  }
});
