import { useState } from "react";

/** @implements spec/feature/session-message-webui-chat.md — original media display */
export function MediaPreview({ url, name, video }: { url: string; name: string; video: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const source = `${url}?raw=1`;
  return <details open={expanded} className="mt-2 rounded border border-border p-2"
    onToggle={(event) => {
      setExpanded(event.currentTarget.open);
      if (event.currentTarget.open) setFailed(false);
    }}>
    <summary className="cursor-pointer break-all text-sm">📎 {name}</summary>
    {expanded && (video
      ? <video key={attempt} src={source} controls playsInline preload="metadata" aria-label={name}
          className="mt-2 max-h-[60dvh] max-w-full" onError={() => setFailed(true)} />
      : <img key={attempt} src={source} alt={name} loading="lazy"
          className="mt-2 max-h-[60dvh] max-w-full object-contain" onError={() => setFailed(true)} />)}
    {failed && <p role="alert" className="text-sm text-danger">メディアを表示できません。ファイルの消失、権限、ブラウザの対応形式を確認してください。
      <button type="button" onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}>再試行</button>
    </p>}
  </details>;
}
