// 設定ページの各セクション。Settings.tsx が左メニューで切り替えて表示する。
// web-hosts: Vite allowedHosts を concordia.config.json 経由で管理。
// runtime kill switch (chat-mute / rules-enabled) は旧 Rules ページの
// AdminTogglesPanel から移設。reaction-workflow / workspace / Lictor は新規。

import { useEffect, useState } from "react";
import { api } from "../../../api.js";


// ─── 共通 UI ────────────────────────────────────────────────────────────

export function ToggleRow(props: {
  label: string;
  hint: string;
  /** true = "禁止中" 側 (warn), false = "稼働中" 側 (ok), null = loading */
  value: boolean | null;
  onToggle: (next: boolean) => void;
  busy: boolean;
  onLabel: string;
  offLabel: string;
  onAction: string;
  offAction: string;
}) {
  const on = props.value === true;
  const stateLabel = props.value === null ? "..." : on ? props.onLabel : props.offLabel;
  const actionLabel = props.value === null ? "..." : on ? props.onAction : props.offAction;
  const stateClasses = props.value === null
    ? "bg-muted text-subtle border-border"
    : on ? "bg-warn/20 border-warn text-warn" : "bg-ok/20 border-ok text-ok";
  return (
    <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
      <div>
        <div className="text-sm font-medium">{props.label}</div>
        <div className="text-xs text-subtle mt-0.5">{props.hint}</div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-subtle shrink-0">現在:</span>
        <span className={`shrink-0 px-2 py-0.5 rounded text-xs border ${stateClasses}`}>{stateLabel}</span>
        <button
          disabled={props.busy || props.value === null}
          onClick={() => props.onToggle(!on)}
          className="ml-auto shrink-0 px-2 py-1 rounded text-xs border bg-accent/15 border-accent text-accent disabled:opacity-40"
          title={`${stateLabel} → ${actionLabel}`}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

/** 1 行のテキスト設定 (現在値 + 入力 + apply)。 */
export function TextSettingRow(props: {
  label: string;
  hint?: React.ReactNode;
  current: string | null;
  placeholder?: string;
  busy: boolean;
  onApply: (value: string) => void;
}) {
  const [draft, setDraft] = useState("");
  useEffect(() => { if (props.current !== null) setDraft(props.current); }, [props.current]);
  return (
    <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
      <div>
        <div className="text-sm font-medium">{props.label}</div>
        {props.hint && <div className="text-xs text-subtle mt-0.5">{props.hint}</div>}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-subtle shrink-0">現在:</span>
        <span className="shrink-0 px-2 py-0.5 rounded text-xs border bg-ok/20 border-ok text-ok font-mono">
          {props.current !== null ? (props.current || "(未設定)") : "..."}
        </span>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={props.busy}
          placeholder={props.placeholder}
          className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono flex-1 min-w-[180px]"
        />
        <button
          disabled={props.busy || draft === (props.current ?? "")}
          onClick={() => props.onApply(draft)}
          className="shrink-0 px-3 py-1 bg-accent/15 border border-accent text-accent rounded text-xs disabled:opacity-40"
        >
          apply
        </button>
      </div>
    </div>
  );
}

/** 複数ワークスペースルートを 1 行 1 パスの textarea で編集する行。 先頭行 = プライマリ。 */
export function MultiRootSettingRow(props: {
  current: string[] | null;
  busy: boolean;
  onApply: (roots: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (props.current !== null) setDraft(props.current.join("\n"));
  }, [props.current]);
  const parsed = draft.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  const currentJoined = (props.current ?? []).join("\n");
  return (
    <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
      <div>
        <div className="text-sm font-medium">ワークスペースルート (複数可)</div>
        <div className="text-xs text-subtle mt-0.5">
          1 行 1 パス。 先頭行がプライマリ (Memoria / Lictor の基点)。 例 <code>E:\Document\Ars</code>。
          空にすると config (env) 既定に戻る。
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-xs text-subtle shrink-0 pt-1">現在:</span>
          <div className="flex flex-col gap-0.5">
            {props.current === null ? (
              <span className="text-xs text-subtle">...</span>
            ) : props.current.length === 0 ? (
              <span className="text-xs text-subtle">(未設定)</span>
            ) : (
              props.current.map((r, i) => (
                <span key={r} className="px-2 py-0.5 rounded text-xs border bg-ok/20 border-ok text-ok font-mono">
                  {i === 0 ? "★ " : ""}{r}
                </span>
              ))
            )}
          </div>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={props.busy}
          rows={3}
          placeholder={"E:\\Document\\Ars\nD:\\Other\\Workspace"}
          className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono w-full"
        />
        <button
          disabled={props.busy || parsed.join("\n") === currentJoined}
          onClick={() => props.onApply(parsed)}
          className="self-start px-3 py-1 bg-accent/15 border border-accent text-accent rounded text-xs disabled:opacity-40"
        >
          apply
        </button>
      </div>
    </div>
  );
}

export async function putJson(path: string, body: unknown): Promise<void> {
  const r = await fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
}
