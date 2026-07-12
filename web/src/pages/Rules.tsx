import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtTs } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";
import { requireOk, runMutation } from "../lib/mutation.js";
import { RuleForm, actionColor } from "./rules/RuleFormPanel.js";
import { useRulesState } from "./rules/useRulesState.js";

export function Rules() {
  const { error, refetch, busy, mode, setMode, form, setForm, formError, formSubmitting, aiAssisting, eventKinds, startCreate, startEdit, cancelForm, toggle, remove, aiAssist, submitForm, rules, logs } = useRulesState();
  if (error) return <div className="text-danger">load error: {error.message}</div>;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-3">
        <header className="flex items-start gap-3">
          <div className="flex-1">
            <h1 className="font-semibold">Rules</h1>
            <p className="text-subtle text-sm mt-1">
              Concordia 内蔵 rule engine. tick または event で claude CLI を spawn し、
              chat 投稿 / rule の追加削除を判断する. 人間も rule を提案できる.
            </p>
          </div>
          {!mode && (
            <button
              onClick={startCreate}
              className="px-3 py-1 bg-accent/20 border border-accent text-accent rounded text-sm"
            >
              + propose rule
            </button>
          )}
        </header>

        {formError && !mode && <div className="text-danger text-sm">{formError}</div>}

        <div className="bg-surface border border-border rounded p-3 text-xs text-subtle">
          runtime kill switch (チャット mute / ルール有効化 / Discord bot) と
          ワークスペース・リアクションWF・Lictor 設定は
          <Link to="/settings" className="text-accent"> 設定</Link> ページに移動しました。
        </div>

        {mode && (
          <RuleForm
            mode={mode}
            form={form}
            setForm={setForm}
            eventKinds={eventKinds}
            formError={formError}
            formSubmitting={formSubmitting}
            aiAssisting={aiAssisting}
            onAssist={() => void aiAssist()}
            onSubmit={() => void submitForm()}
            onCancel={cancelForm}
          />
        )}

        {rules.length === 0 && (
          <div className="bg-surface border border-border rounded p-4 text-subtle text-sm">no rules</div>
        )}

        {rules.map((r) => (
          <article key={r.id} className="bg-surface border border-border rounded p-3">
            <div className="flex items-center gap-2 text-xs">
              <span
                className={
                  "px-1.5 py-0.5 rounded " +
                  (r.enabled
                    ? "bg-ok/20 text-ok"
                    : !r.removed_at && r.added_by === "human"
                      ? "bg-warn/20 text-warn"
                      : "bg-subtle/20 text-subtle")
                }
              >
                {r.enabled
                  ? "enabled"
                  : !r.removed_at && r.added_by === "human"
                    ? "review待ち"
                    : "disabled"}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-muted">{r.trigger_type}</span>
              {r.tick_sec && (
                <span className="text-subtle">every {r.tick_sec}s</span>
              )}
              {r.event_kind && (
                <span className="text-subtle">on {r.event_kind}</span>
              )}
              <span className="text-subtle">cooldown {r.cooldown_sec}s</span>
              <span className="ml-auto text-subtle">by {r.added_by}</span>
              <button
                onClick={() => startEdit(r)}
                disabled={busy === r.id}
                className="ml-2 text-subtle hover:text-accent"
              >
                edit
              </button>
              <button
                onClick={() => toggle(r.id)}
                disabled={busy === r.id}
                className="text-subtle hover:text-accent"
              >
                toggle
              </button>
              <button
                onClick={() => remove(r.id)}
                disabled={busy === r.id}
                className="text-subtle hover:text-danger"
              >
                remove
              </button>
            </div>
            <h2 className="mt-2 font-mono">{r.id}</h2>
            {r.description && <div className="text-subtle text-sm">{r.description}</div>}
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-subtle">instructions</summary>
              <pre className="mt-1 bg-muted p-2 rounded whitespace-pre-wrap">{r.instructions}</pre>
            </details>
            <div className="mt-2 flex gap-3 text-[11px] text-subtle">
              {r.last_fired_at && <span>last fired: {fmtTs(r.last_fired_at)}</span>}
              {r.removed_at && (
                <span className="text-warn">
                  removed by {r.removed_by} @ {fmtTs(r.removed_at)} ({r.removed_reason ?? "?"})
                </span>
              )}
            </div>
          </article>
        ))}
      </div>

      <aside className="space-y-2">
        <h2 className="font-semibold">最近のログ</h2>
        <ul className="space-y-1">
          {logs.map((l) => (
            <li
              key={l.id}
              className="bg-surface border border-border rounded px-2 py-1 text-[11px]"
            >
              <div className="flex items-center gap-2">
                <span className={actionColor(l.action)}>{l.action}</span>
                <span className="text-subtle font-mono">{l.rule_id ?? "-"}</span>
                <span className="text-subtle ml-auto">{fmtTs(l.ts)}</span>
              </div>
              {l.detail && (
                <div className="text-subtle mt-0.5 truncate">[{l.actor}] {l.detail}</div>
              )}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
