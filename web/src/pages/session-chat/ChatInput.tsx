import { useState } from "react";

/** @implements spec/feature/session-message-webui-chat.md — D4 command input */

export function ChatInput({ onSubmit, disabled }: { onSubmit: (text: string) => Promise<string | null>; disabled: boolean }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      const result = await onSubmit(value);
      if (result) {
        setError(result);
        return;
      }
      setError(null);
      setValue("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="border-t border-border bg-surface p-3"
    >
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isComposing && event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        disabled={disabled || busy}
        rows={3}
        className="foundation-form w-full resize-none"
        placeholder="メッセージ、または /stop /rename /enter /stat"
      />
      <div className="mt-2 flex items-center gap-2">
        <button type="submit" disabled={disabled || busy} className="rounded bg-accent px-3 py-1 text-sm text-white disabled:opacity-50">
          送信
        </button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </form>
  );
}
