// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { usePolling } from "./usePolling.js";
import { TaskflowLoadError } from "../../lib/taskflow-failure.js";

it("starts the next poll after a rejection", async () => {
  vi.useFakeTimers();
  const load = vi.fn()
    .mockResolvedValueOnce("previous")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce("current");
  const view = renderHook(() => usePolling<string>(load, 1000));
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.result.current).toMatchObject({ data: "previous", reconnecting: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.result.current).toMatchObject({ data: "current", reconnecting: false, error: null });
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it("preserves Actio configuration guidance when the backend returns 503", async () => {
  const error = new TaskflowLoadError("actio_configuration_invalid", 503);
  const load = vi.fn().mockRejectedValue(error);
  const view = renderHook(() => usePolling<string>(load, 30_000));
  try {
    await act(async () => {});
    expect(view.result.current).toMatchObject({ error: error.message, reconnecting: false });
  } finally {
    view.unmount();
  }
});

it("refreshes when visible, ignores a superseded response and removes the listener on unmount", async () => {
  let completeOld: (value: string) => void = () => {
    throw new Error("initial read did not start");
  };
  const old = new Promise<string>(resolve => { completeOld = resolve; });
  const load = vi.fn<(signal: AbortSignal) => Promise<string>>()
    .mockReturnValueOnce(old)
    .mockResolvedValue("current");
  const visibility = vi.spyOn(document, "visibilityState", "get");
  const view = renderHook(() => usePolling(load, 30_000));
  try {
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(load).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(load.mock.calls[0]![0].aborted).toBe(true);
    await act(async () => { completeOld("old"); });
    expect(view.result.current.data).toBe("current");
    view.unmount();
    window.dispatchEvent(new Event("online"));
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    visibility.mockRestore();
  }
});
