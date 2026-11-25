import { useCallback, useEffect, useRef, useState } from "react";
import { onBrowserResume } from "../../lib/browser-resume.js";
import { TaskflowLoadError } from "../../lib/taskflow-failure.js";
import { wsClient } from "../../lib/ws-client.js";
import { ApiError } from "./controlApi.js";

const REQUEST_TIMEOUT_MS = 20_000;
const RESUME_COALESCE_MS = 250;

type ReadFailure = { message: string; reconnecting: boolean };
type Attempt = {
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
  resumedAt: number | null;
};

const TRANSIENT_TASKFLOW_REASONS = new Set([
  "taskflow_connection_failed",
  "actio_unavailable",
  "actio_unreachable",
  "actio_read_timeout",
  "revisor_lookup_unavailable",
]);

function isRetryableStatus(status: number | undefined): boolean {
  return status !== undefined && (status === 408 || status === 429 || status >= 500);
}

function readFailure(error: unknown): ReadFailure {
  const reconnecting = error instanceof TaskflowLoadError
    ? TRANSIENT_TASKFLOW_REASONS.has(error.reason)
      || (error.reason === "taskflow_request_failed" && isRetryableStatus(error.status))
    : error instanceof TypeError || (error instanceof ApiError && isRetryableStatus(error.status));
  return {
    message: error instanceof Error ? error.message : String(error),
    reconnecting,
  };
}

/** Automatic reads pause at a null interval and keep their last snapshot during recovery. */
export function usePolling<T>(load: (signal: AbortSignal) => Promise<T>, intervalMs: number | null): {
  data: T | null; error: string | null; reconnecting: boolean; reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [failure, setFailure] = useState<ReadFailure | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const attempt = useRef<Attempt | null>(null);

  const cancel = useCallback(() => {
    const current = attempt.current;
    attempt.current = null;
    if (!current) return;
    clearTimeout(current.timeout);
    current.controller.abort();
  }, []);

  const read = useCallback(async (resumedAt: number | null = null) => {
    cancel();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      if (attempt.current?.controller !== controller) return;
      cancel();
      setFailure({ message: "取得がタイムアウトしました", reconnecting: true });
    }, REQUEST_TIMEOUT_MS);
    attempt.current = { controller, timeout, resumedAt };
    try {
      const value = await loadRef.current(controller.signal);
      if (controller.signal.aborted) return;
      setData(value);
      setFailure(null);
    } catch (error) {
      if (!controller.signal.aborted) setFailure(readFailure(error));
    } finally {
      clearTimeout(timeout);
      if (attempt.current?.controller === controller) attempt.current = null;
    }
  }, [cancel]);

  const reload = useCallback(() => { void read(); }, [read]);

  useEffect(() => {
    if (intervalMs === null) return cancel;
    reload();
    const timer = setInterval(() => {
      if (!attempt.current) reload();
    }, intervalMs);
    const refresh = () => {
      const previousResume = attempt.current?.resumedAt;
      const now = Date.now();
      if (previousResume != null && now - previousResume < RESUME_COALESCE_MS) return;
      void read(now);
    };
    const stopWatchingBrowser = onBrowserResume(refresh);
    const stopWatchingSocket = wsClient.onEvent("hello", reload);
    return () => {
      clearInterval(timer);
      stopWatchingBrowser();
      stopWatchingSocket();
      cancel();
    };
  }, [cancel, read, reload, intervalMs]);
  return { data, error: failure?.message ?? null, reconnecting: failure?.reconnecting ?? false, reload };
}
