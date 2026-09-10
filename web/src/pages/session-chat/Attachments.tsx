import { useEffect, useState } from "react";
import { fmtTs } from "../../api.js";
import { MediaPreview } from "./MediaPreview.js";

/** @implements spec/feature/session-message-webui-chat.md — 添付の閲覧 */
export interface AttachmentMessage {
  id: number; ts: number; author_label: string; content: string;
  files: Array<{ index: number; name: string }>;
}

export async function loadAttachmentMessages(id: string): Promise<AttachmentMessage[]> {
  const response = await fetch(`/v1/sessions/${encodeURIComponent(id)}/chat-attachments`);
  if (!response.ok) throw new Error(`添付一覧の取得に失敗しました (${response.status})`);
  const messages = (await response.json())?.messages;
  return Array.isArray(messages) ? messages : [];
}

function imageSource(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const image = value as Record<string, unknown>;
  if (image.kind !== "image" || typeof image.media_type !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(image.media_type)) return null;
  if (typeof image.data !== "string" || image.data.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return null;
  return `data:${image.media_type};base64,${image.data}`;
}

export function InlineAttachments({ attachments }: { attachments: unknown[] | null }) {
  return <>{attachments?.map((attachment, index) => {
    const source = imageSource(attachment);
    return source ? <details open key={index} className="my-2 rounded border border-border p-2">
      <summary className="cursor-pointer">画像 {index + 1} を表示</summary>
      <img src={source} alt={`添付画像 ${index + 1}`} loading="lazy" className="mt-2 max-h-[70vh] max-w-full object-contain" />
    </details> : <p key={index} className="text-xs text-subtle">表示できない添付形式です</p>;
  })}</>;
}

function FilePreview({ url, name }: { url: string; name: string }) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<{ kind: string; content?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setPreview(null); setError(null);
    void fetch(url, { signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `取得失敗 (${response.status})`);
      if (!controller.signal.aborted) setPreview(body);
    }).catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [expanded, url, attempt]);
  const source = preview?.kind === "image" ? imageSource(preview) : null;
  return <details className="mt-2 rounded border border-border p-2" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer break-all">📎 {name} — 内容を表示</summary>
    {expanded && !preview && !error && <p role="status">読み込み中…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setAttempt((n) => n + 1)}>再試行</button></p>}
    {preview?.kind === "text" && <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-sm">{preview.content}</pre>}
    {source && <img src={source} alt={name} className="mt-2 max-h-[70vh] max-w-full object-contain" />}
  </details>;
}

export function AttachmentMessageItem({ sessionId, message }: { sessionId: string; message: AttachmentMessage }) {
  return <article className="rounded px-2 py-1.5">
    <div className="text-xs text-subtle">{message.author_label} · {fmtTs(message.ts)}</div>
    <div className="whitespace-pre-wrap break-words">{message.content}</div>
    {message.files.map((file) => {
      const url = `/v1/sessions/${encodeURIComponent(sessionId)}/chat-attachments/${message.id}/${file.index}`;
      const video = /\.(mp4|m4v|webm|mov)$/i.test(file.name);
      return video || /\.(png|jpe?g|gif|webp)$/i.test(file.name)
        ? <MediaPreview key={`${url}:${file.name}`} name={file.name} url={url} video={video} />
        : <FilePreview key={file.index} name={file.name} url={url} />;
    })}
  </article>;
}
