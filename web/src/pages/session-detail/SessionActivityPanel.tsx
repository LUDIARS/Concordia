import { useEffect, useRef, useState } from "react";
import { api, fmtTs } from "../../api.js";
import { useWsEvent } from "../../hooks/useWsEvent.js";
import { toActivityMessage, type ActivityTone } from "./activity-chat.js";
import { extractClaudeUuid, ForkFromButton, mergeBySeq, type TranscriptFrame } from "./shared.js";

const ACTIVITY_FRAME_LIMIT = 1_000;

export function SessionActivityPanel({ sessionId }: { sessionId: string }) {
  const [frames, setFrames] = useState<TranscriptFrame[]>([]);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);
  const knownSeqRef = useRef(new Set<number>());

  useEffect(() => {
    let cancelled = false;
    setFrames([]);
    setTotal(0);
    setLoadError(null);
    knownSeqRef.current = new Set();
    shouldFollowRef.current = true;

    void api.sessionTranscript(sessionId, { limit: ACTIVITY_FRAME_LIMIT, tail: true })
      .then((response) => {
        if (cancelled) return;
        const seeded = response.entries.map((entry) => ({
          seq: entry.seq,
          kind: entry.kind,
          payload: entry.payload,
          ts: entry.ts,
        }));
        knownSeqRef.current = new Set(seeded.map((frame) => frame.seq));
        setTotal(response.total);
        setFrames(seeded);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError((error as Error).message);
      });

    return () => { cancelled = true; };
  }, [sessionId]);

  useWsEvent(["transcript.frame"], (event) => {
    if (event.type !== "transcript.frame" || event.target_session_id !== sessionId) return;
    if (knownSeqRef.current.has(event.seq)) return;
    knownSeqRef.current.add(event.seq);
    setTotal((current) => current + 1);
    setFrames((current) =>
      mergeBySeq(current, [{ seq: event.seq, kind: event.kind, payload: event.payload, ts: event.ts }])
        .slice(-ACTIVITY_FRAME_LIMIT),
    );
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !shouldFollowRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [frames.length]);

  return (
    <section className="bg-surface border border-border rounded p-3 flex flex-col h-[65vh] min-h-[32rem] max-h-[56rem]">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <h2 className="text-lg font-semibold">作業内容</h2>
        <span className="px-2 py-0.5 rounded bg-ok/15 text-ok text-xs">最適化なし・全文表示</span>
        <span className="text-xs text-subtle ml-auto">
          {frames.length}/{total} frame
          {total > ACTIVITY_FRAME_LIMIT ? `（最新 ${ACTIVITY_FRAME_LIMIT} 件）` : ""}
        </span>
      </div>
      {loadError && <div className="mb-2 text-xs text-danger">transcript load error: {loadError}</div>}
      {frames.length === 0 ? (
        <div className="flex-1 grid place-items-center text-sm text-subtle">まだ作業ログがありません。</div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            shouldFollowRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
          className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1"
        >
          {frames.map((frame) => {
            const message = toActivityMessage(frame);
            const claudeUuid = extractClaudeUuid(frame.payload);
            return (
              <div
                key={frame.seq}
                className={`rounded-xl border px-4 py-3 ${activityToneClass(message.tone)}`}
              >
                <div className="flex items-center gap-2 text-xs text-subtle flex-wrap">
                  <span className="font-semibold text-text">{message.author}</span>
                  {message.detail && <span className="font-mono opacity-80">{message.detail}</span>}
                  <span>#{frame.seq}</span>
                  {claudeUuid && <ForkFromButton sessionId={sessionId} claudeUuid={claudeUuid} />}
                  <span className="ml-auto">{fmtTs(frame.ts)}</span>
                </div>
                {message.imageDataUrl && (
                  <img
                    src={message.imageDataUrl}
                    alt={`transcript image frame ${frame.seq}`}
                    className="mt-3 max-h-[32rem] max-w-full rounded border border-border object-contain"
                  />
                )}
                {message.text && (
                  <pre className={`mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed ${
                    message.tone === "user" || message.tone === "assistant" ? "font-sans" : "font-mono"
                  }`}>
                    {message.text}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function activityToneClass(tone: ActivityTone): string {
  switch (tone) {
    case "user": return "bg-accent/10 border-accent/40";
    case "assistant": return "bg-ok/5 border-ok/30";
    case "tool": return "bg-muted/70 border-border";
    case "thinking": return "bg-warn/5 border-warn/25";
    case "summary": return "bg-accent/5 border-accent/20 border-dashed";
    case "system": return "bg-muted/30 border-border/70";
  }
}
