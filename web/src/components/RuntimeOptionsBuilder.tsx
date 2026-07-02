import { useState } from "react";
import type { DelegationOptionSuggestion } from "../api.js";

// runtime options の「項目を選んで追加していく」ビルダー。
// 正本は親が保持する JSON 文字列 (json prop)。本コンポーネントは項目の追加/削除で
// その JSON を書き換えるビューであり、生 JSON textarea (親側) と併存する前提。
// JSON textarea 側で不正な JSON になっている間は項目編集を無効化して警告を出す
// (黙って壊れた JSON を上書きしない)。
export interface RuntimeOptionsBuilderProps {
  suggestions: DelegationOptionSuggestion[];
  json: string;
  onJsonChange: (json: string) => void;
}

const CUSTOM_KEY = "__custom__";

function parseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// サジェスト型に応じて入力文字列を JSON 値へ変換する。
// カスタムキーは JSON として解釈できればその値 (数値/真偽/object 等)、できなければ文字列。
function coerceValue(raw: string, type: DelegationOptionSuggestion["type"] | null): unknown {
  if (type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  if (type === "select" || type === "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function RuntimeOptionsBuilder({ suggestions, json, onJsonChange }: RuntimeOptionsBuilderProps) {
  const [pendingKey, setPendingKey] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [pendingValue, setPendingValue] = useState("");

  const entries = parseObject(json);
  const selected = suggestions.find((s) => s.key === pendingKey) ?? null;
  const isCustom = pendingKey === CUSTOM_KEY;
  const effectiveKey = isCustom ? customKey.trim() : pendingKey;

  function resetPending() {
    setPendingKey("");
    setCustomKey("");
    setPendingValue("");
  }

  function add() {
    if (entries === null || !effectiveKey || pendingValue === "") return;
    const next = { ...entries, [effectiveKey]: coerceValue(pendingValue, selected?.type ?? null) };
    onJsonChange(JSON.stringify(next, null, 2));
    resetPending();
  }

  function remove(key: string) {
    if (entries === null) return;
    const next = { ...entries };
    delete next[key];
    onJsonChange(JSON.stringify(next, null, 2));
  }

  if (entries === null) {
    return (
      <div className="text-xs text-danger">
        JSON が不正なため項目編集は無効です。下の JSON を直接修正してください。
      </div>
    );
  }

  const entryKeys = Object.keys(entries);

  return (
    <div className="space-y-2">
      {entryKeys.length > 0 && (
        <ul className="space-y-1">
          {entryKeys.map((key) => {
            const suggestion = suggestions.find((s) => s.key === key);
            return (
              <li key={key} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs">{key}</span>
                <span className="text-subtle">=</span>
                <span className="font-mono text-xs break-all">{JSON.stringify(entries[key])}</span>
                {suggestion && <span className="text-xs text-subtle">({suggestion.label})</span>}
                <button
                  type="button"
                  onClick={() => remove(key)}
                  className="text-xs text-red-500 ml-auto shrink-0"
                >削除</button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-start gap-2">
        <select
          className="foundation-form"
          value={pendingKey}
          onChange={(e) => { setPendingKey(e.target.value); setPendingValue(""); }}
        >
          <option value="">項目を選択…</option>
          {suggestions.map((s) => (
            <option key={s.key} value={s.key}>{s.label} ({s.key})</option>
          ))}
          <option value={CUSTOM_KEY}>カスタムキー…</option>
        </select>
        {isCustom && (
          <input
            className="foundation-form"
            placeholder="key"
            value={customKey}
            onChange={(e) => setCustomKey(e.target.value)}
          />
        )}
        {pendingKey !== "" && (
          selected?.type === "select" ? (
            <select
              className="foundation-form"
              value={pendingValue}
              onChange={(e) => setPendingValue(e.target.value)}
            >
              <option value="">値を選択…</option>
              {(selected.choices ?? []).map((choice) => (
                <option key={choice.value} value={choice.value}>{choice.label}</option>
              ))}
            </select>
          ) : selected?.type === "boolean" ? (
            <select
              className="foundation-form"
              value={pendingValue}
              onChange={(e) => setPendingValue(e.target.value)}
            >
              <option value="">値を選択…</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              className="foundation-form"
              placeholder={isCustom ? 'value (JSON 可: 3 / true / {"a":1})' : "value"}
              value={pendingValue}
              onChange={(e) => setPendingValue(e.target.value)}
            />
          )
        )}
        {pendingKey !== "" && (
          <button
            type="button"
            onClick={add}
            disabled={!effectiveKey || pendingValue === ""}
            className="border border-border px-3 py-1.5 rounded text-sm disabled:opacity-50"
          >{effectiveKey && entryKeys.includes(effectiveKey) ? "上書き" : "追加"}</button>
        )}
      </div>
      {selected?.description && (
        <div className="text-xs text-subtle">{selected.description}</div>
      )}
    </div>
  );
}
