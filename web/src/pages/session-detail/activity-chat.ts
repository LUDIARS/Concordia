import type { TranscriptFrame } from "./shared.js";

export type ActivityTone = "user" | "assistant" | "tool" | "thinking" | "summary" | "system";

export interface ActivityMessage {
  author: string;
  detail: string | null;
  text: string;
  tone: ActivityTone;
  imageDataUrl: string | null;
}

const USER_FACING_ACTIVITY_KINDS = new Set(["text", "summary", "image"]);

/**
 * Keep user-facing messages in the main timeline. Provider protocol frames and
 * tool payloads remain available as diagnostics, but belong in a collapsed
 * technical-events group so they do not bury progress updates.
 */
export function isCollapsibleActivityFrame(frame: TranscriptFrame): boolean {
  return !USER_FACING_ACTIVITY_KINDS.has(frame.kind);
}

export function toActivityMessage(frame: TranscriptFrame): ActivityMessage {
  const payload = asRecord(frame.payload);
  if (frame.kind === "text") {
    const role = readString(payload, "role");
    const phase = readString(payload, "phase");
    return {
      author: role === "user" ? "指示" : "Assistant",
      detail: describePhase(phase),
      text: readString(payload, "text") ?? formatFullPayload(frame.payload),
      tone: role === "user" ? "user" : "assistant",
      imageDataUrl: null,
    };
  }

  if (frame.kind === "summary") {
    return {
      author: "Conversation summary",
      detail: "詳細ログと併記",
      text: readString(payload, "text") ?? readString(payload, "summary") ?? formatFullPayload(frame.payload),
      tone: "summary",
      imageDataUrl: null,
    };
  }

  if (frame.kind === "thinking") {
    return {
      author: "Thinking",
      detail: null,
      text: readString(payload, "text") ?? readString(payload, "preview") ?? formatFullPayload(frame.payload),
      tone: "thinking",
      imageDataUrl: null,
    };
  }

  if (frame.kind === "image") {
    const mediaType = readString(payload, "media_type") ?? "image/png";
    const data = readString(payload, "data");
    return {
      author: "Image",
      detail: mediaType,
      text: data ? "" : formatFullPayload(frame.payload),
      tone: "tool",
      imageDataUrl: data ? `data:${mediaType};base64,${data}` : null,
    };
  }

  if (frame.kind === "tool" || frame.kind === "tool-use" || frame.kind === "tool-result") {
    return {
      author: "Tool",
      detail: readString(payload, "name") ?? readString(payload, "type") ?? frame.kind,
      text: formatFullPayload(frame.payload),
      tone: "tool",
      imageDataUrl: null,
    };
  }

  return {
    author: frame.kind === "system" ? "System" : "Activity",
    detail: readString(payload, "type") ?? frame.kind,
    text: readString(payload, "text") ?? formatFullPayload(frame.payload),
    tone: "system",
    imageDataUrl: null,
  };
}

export function formatFullPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2) ?? String(payload ?? "");
  } catch {
    return String(payload ?? "");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function readString(value: Record<string, unknown> | null, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : null;
}

function describePhase(phase: string | null): string | null {
  if (phase === "commentary") return "作業更新";
  if (phase === "final_answer") return "最終回答";
  return phase;
}
