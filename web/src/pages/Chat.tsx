import { useState, useEffect, useRef } from "react";
import { api, fmtTs } from "../api.js";
import type { ChatMessage, DelegationTemplateLite, SessionRow } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";
import { runMutation } from "../lib/mutation.js";

const CHANNELS = ["chitchat", "consultation", "報告", "ぼやき"] as const;
type Channel = (typeof CHANNELS)[number];

/** provider 種別 → フォールバック絵文字 (delegation テンプレ未登録 / モデル特定不可時)。 */
const PROVIDER_EMOJI: Record<string, string> = {
  "claude-code": "🤖",
  "codex-cli":   "💻",
  "gemini-cli":  "💎",
  "local-llm":   "🇬",
};

/** model_id のパターンに対応する絵文字を返す。 delegation テンプレの emoji を優先。 */
function emojiFromModelId(modelId: string, modelEmojiMap: Map<string, string>): string {
  if (modelEmojiMap.has(modelId)) return modelEmojiMap.get(modelId)!;
  // パターンマッチのフォールバック
  if (modelId.includes("haiku"))    return "🗣️";
  if (modelId.includes("fable"))    return "🦸";
  if (modelId.includes("opus"))     return "🧙‍♂️";
  if (modelId.includes("sonnet"))   return "🧑‍💼";
  if (modelId.includes("gemma"))    return "🇬";
  if (modelId.includes("gemini"))   return "💎";
  return "";
}

/** セッション ID → 絵文字 を解決するフック。 */
function useSessionEmoji() {
  const modelEmojiMap = useRef<Map<string, string>>(new Map());
  const sessionMap = useRef<Map<string, SessionRow>>(new Map());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Promise.all([
      api.delegationTemplates().catch(() => ({ templates: [] as DelegationTemplateLite[] })),
      api.monitor().catch(() => null),
    ]).then(([tplRes, monRes]) => {
      const m = new Map<string, string>();
      for (const t of tplRes.templates) {
        if (t.emoji && t.model) m.set(t.model, t.emoji);
      }
      modelEmojiMap.current = m;
      const sm = new Map<string, SessionRow>();
      for (const s of [
        ...(monRes?.active ?? []),
        ...(monRes?.lost ?? []),
        ...(monRes?.recent_ended ?? []),
      ]) {
        sm.set(s.id, s);
      }
      sessionMap.current = sm;
      setReady(true);
    });
  }, []);

  const resolve = (sessionId: string | null): string => {
    if (!sessionId) return "";
    const s = sessionMap.current.get(sessionId);
    if (!s) return "";
    const meta = s.metadata as Record<string, unknown> | null;
    const modelId = (meta?.model_id ?? meta?.model ?? "") as string;
    if (modelId) {
      const e = emojiFromModelId(modelId, modelEmojiMap.current);
      if (e) return e;
    }
    return PROVIDER_EMOJI[s.provider] ?? "";
  };

  return { resolve, ready };
}

export function Chat() {
  const [channel, setChannel] = useState<Channel>("chitchat");
  const { data, error } = useLiveQuery(
    () => api.chatList(channel, 50),
    ["chat.posted"],
    channel,
  );
  const [input, setInput] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const { resolve: resolveEmoji } = useSessionEmoji();

  const send = async () => {
    if (!input.trim() || posting) return;
    await runMutation({
      setBusy: setPosting,
      setError: setPostError,
      action: () => api.chatPost({ channel, text: input.trim(), author_label: "human" }),
      onSuccess: () => setInput(""),
      errorPrefix: "投稿失敗: ",
    });
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
      {postError && <div className="text-danger text-sm">{postError}</div>}

      <div className="bg-surface border border-border rounded p-3 h-[60vh] overflow-y-auto space-y-2">
        {messages.length === 0 && (
          <div className="text-subtle text-sm text-center py-8">no messages yet</div>
        )}
        {messages.map((m) => (
          <ChatRow key={m.id} m={m} emoji={resolveEmoji(m.session_id)} />
        ))}
      </div>

      <div className="flex gap-2">
        <input
          className="flex-1 foundation-form text-sm"
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

function ChatRow({ m, emoji }: { m: ChatMessage; emoji: string }) {
  const isHuman = m.author_label === "human";
  return (
    <div
      className={
        "flex flex-col gap-0.5 " + (m.in_reply_to ? "ml-6" : "")
      }
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span className={isHuman ? "text-warn" : "text-accent"}>
          {!isHuman && emoji && <span className="mr-0.5">{emoji}</span>}
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
