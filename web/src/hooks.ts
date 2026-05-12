import { useEffect, useRef, useState } from "react";

/** 単純な polling hook. interval ms ごとに fetcher を回す */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const v = await fetcherRef.current();
        if (!cancelled) setData(v);
        if (!cancelled) setError(null);
      } catch (e) {
        if (!cancelled) setError(e as Error);
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);

  return { data, error };
}
