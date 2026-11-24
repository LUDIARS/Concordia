import { useCallback, useEffect, useRef, useState } from "react";

/** 一定間隔で読み直す。読めなかった回は error を立て、前回の値は残す (欄ごとに「取得できません」と出すため)。 */
export function usePolling<T>(load: (signal: AbortSignal) => Promise<T>, intervalMs: number): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const controller = useRef<AbortController | null>(null);
  const reload = useCallback(() => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    loadRef.current(next.signal)
      .then((value) => { if (!next.signal.aborted) { setData(value); setError(null); } })
      .catch((e: unknown) => { if (!next.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
  }, []);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, intervalMs);
    return () => { clearInterval(timer); controller.current?.abort(); };
  }, [reload, intervalMs]);
  return { data, error, reload };
}
