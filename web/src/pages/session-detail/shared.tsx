import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../../api.js";
import type { SessionEvent, SessionRow } from "../../api.js";
import { useLiveQuery, useWsEvent } from "../../hooks/useWsEvent.js";
import { projectCodeFor, repoBasename } from "../../project-codes.js";

export interface TranscriptFrame { seq: number; kind: string; payload: unknown; ts: number; }

export function mergeBySeq(existing: TranscriptFrame[], incoming: TranscriptFrame[]): TranscriptFrame[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((f) => f.seq));
  const added = incoming.filter((f) => !seen.has(f.seq));
  if (added.length === 0) return existing;
  const merged = [...existing, ...added];
  merged.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
  return merged;
}

export function extractRole(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as { role?: unknown }).role;
  return typeof v === "string" ? v : null;
}

export function extractText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as { text?: unknown }).text;
  return typeof v === "string" ? v : null;
}

export function extractClaudeUuid(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as { claude_uuid?: unknown }).claude_uuid;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function renderFramePayload(kind: string, payload: unknown): string {
  if (kind === "text" && payload && typeof payload === "object" && "text" in (payload as any)) {
    return String((payload as { text: unknown }).text).slice(0, 800);
  }
  const s = JSON.stringify(payload, null, 2) ?? "";
  return s.length > 800 ? s.slice(0, 800) + "…" : s;
}

export function ForkFromButton({ sessionId, claudeUuid }: { sessionId: string; claudeUuid: string }) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    if (busy) return;
    if (!confirm(`このメッセージから fork します (${claudeUuid.slice(0, 8)}…) — 新タブで lictor wrapped claude が起動します`)) return;
    setBusy(true);
    try {
      await api.sessionFork(sessionId, { claude_uuid: claudeUuid });
    } catch (e) {
      alert(`fork failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={click}
      disabled={busy}
      title={`fork from ${claudeUuid}`}
      className="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent hover:bg-accent/40 disabled:opacity-50"
    >
      {busy ? "…" : "🔱 fork"}
    </button>
  );
}

export function kindBadge(kind: string): string {
  const base = "px-1.5 py-0.5 rounded text-[10px] font-mono";
  switch (kind) {
    case "start":   return `${base} bg-ok/20 text-ok`;
    case "end":     return `${base} bg-subtle/20 text-subtle`;
    case "lost":    return `${base} bg-warn/20 text-warn`;
    case "edit":    return `${base} bg-accent/20 text-accent`;
    case "compact": return `${base} bg-warn/10 text-warn`;
    case "inject":  return `${base} bg-accent/30 text-accent`;
    default:        return `${base} bg-muted text-subtle`;
  }
}
