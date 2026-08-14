/**
 * useWsEvent — Concordia WS の event を購読する React hook.
 *
 * 使い方:
 *   useWsEvent("chat.posted", (ev) => refetch());
 *   useWsEvent(["session.started", "session.ended", "session.lost"], () => refetch());
 *   useWsEvent(null, (ev) => console.log(ev));    // 全 event
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { wsClient, type ConcordiaEvent } from "../lib/ws-client.js";

type EventType = ConcordiaEvent["type"];
type Filter = EventType | EventType[] | null;

export function useWsEvent(filter: Filter, callback: (ev: ConcordiaEvent) => void): void {
  const cbRef = useRef(callback);
  useEffect(() => { cbRef.current = callback; });

  const key = Array.isArray(filter) ? filter.join("|") : (filter ?? "*");

  useEffect(() => {
    const set =
      filter === null
        ? null
        : new Set<EventType>(Array.isArray(filter) ? filter : [filter]);

    const off = wsClient.onMessage((ev) => {
      if (set === null || set.has(ev.type)) {
        cbRef.current(ev);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/**
 * 初回 fetch + 関連 event で refetch する live query.
 *
 * @param fetcher 初回 + refetch で呼ばれる関数
 * @param events  refetch trigger になる WS event type 群 (空なら fetch のみで refetch なし)
 * @param refreshKey 依存値 (URL param など) が変わったら refetch を強制
 */
export function useLiveQuery<T>(
  fetcher: () => Promise<T>,
  events: EventType[],
  refreshKey: unknown = null,
): { data: T | null; error: Error | null; refetch: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const requestGenerationRef = useRef(0);

  const doFetch = useCallback(() => {
    const generation = ++requestGenerationRef.current;
    void fetcherRef.current()
      .then((d) => {
        if (generation !== requestGenerationRef.current) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (generation === requestGenerationRef.current) {
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      });
  }, []);

  const eventsKey = events.join("|");

  useEffect(() => {
    setData(null);
    setError(null);
    doFetch();
    return () => { requestGenerationRef.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsKey, refreshKey]);

  useWsEvent(events.length > 0 ? events : null, () => {
    if (events.length === 0) return; // null filter 時の暴発防止
    doFetch();
  });

  return { data, error, refetch: doFetch };
}
