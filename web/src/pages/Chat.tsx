import { useState } from "react";
import { api, fmtTs } from "../api.js";
import type { ChatMessage } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";

const CHANNELS = ["chitchat", "consultation", "報告"] as const;
type Channel = (typeof CHANNELS)[number];

export function Chat() {
  const [channel, setChannel] = useState<Channel>("chitchat");
  const { data, error } = useLiveQuery(
    () => api.chatList(channel, 50),
    ["chat.posted"],
    channel,
  );
  const [input, setInput] = useState("");
  const [posting, setPosting] = useState(false);

  const send = async () => {
    if (!input.trim() || posting) return;
    setPosting(true);
    try {
      await api.chatPost({
        channel,
        text: input.trim(),
        author_label: "human",
      });
      setInput("");
    } finally {
      setPosting(false);
    }
  };

  // 1 番上が最新。 API が新→古で返すのでそのまま使う。
  const messages = data?.messages ?? [];

  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex items-center gap-2">
        {CHANNELS.map((c) => (
          <button
            key={c}
            onClick={() => setChannel(c)}
            className={
              "px-3 py-1 rounded text-sm border " +
              (channel === c
                ? "bg-accent/20 border-accent text-accent"
                : "border-border text-subtle hover:text-text")
            }
          >
            #{c}
          </button>
        ))}
        <span className="ml-auto text-xs text-subtle">
          live (WS push) · 人間として投稿可
        </span>
      </div>

      {error && <div className="text-danger text-sm">load error: {error.message}</div>}

      <div className="bg-surface border border-border rounded p-3 h-[60vh] overflow-y-auto space-y-2">
        {messages.length === 0 && (
          <div className="text-subtle text-sm text-center py-8">no messages yet</div>
        )}
        {messages.map((m) => (
          <ChatRow key={m.id} m={m} />
        ))}
      </div>

      <div className="flex gap-2">
        <input
          className="flex-1 bg-surface border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent"
          placeholder={`#${channel} に投稿…`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          onClick={() => void send()}
          disabled={posting || !input.trim()}
          className="px-4 py-2 bg-accent/20 border border-accent text-accent rounded text-sm hover:bg-accent/30 disabled:opacity-50"
        >
          send
        </button>
      </div>
    </div>
  );
}

function ChatRow({ m }: { m: ChatMessage }) {
  const isHuman = m.author_label === "human";
  return (
    <div
      className={
        "flex flex-col gap-0.5 " + (m.in_reply_to ? "ml-6" : "")
      }
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span className={isHuman ? "text-warn" : "text-accent"}>
          {m.author_label}
        </span>
        {m.session_id && (
          <span className="text-subtle font-mono">{m.session_id.slice(0, 6)}</span>
        )}
        <span className="text-subtle ml-auto">{fmtTs(m.ts)}</span>
        {m.is_actionable && (
          <span className="px-1 bg-warn/20 text-warn text-[10px] rounded">
            actionable
          </span>
        )}
        {m.in_reply_to && (
          <span className="text-subtle text-[10px]">↳ #{m.in_reply_to}</span>
        )}
      </div>
      <div className="text-sm whitespace-pre-wrap">{m.text}</div>
    </div>
  );
}
