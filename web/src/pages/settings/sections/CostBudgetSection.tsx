// 設定ページの各セクション。Settings.tsx が左メニューで切り替えて表示する。
// web-hosts: Vite allowedHosts を concordia.config.json 経由で管理。
// runtime kill switch (chat-mute / rules-enabled) は旧 Rules ページの
// AdminTogglesPanel から移設。reaction-workflow / workspace / Lictor は新規。

import { useEffect, useState } from "react";
import { api } from "../../../api.js";

import { putJson } from "./common.js";

// ─── コスト予算 (日次トークン上限 + 超過ブロック) ────────────────────────

export function CostBudgetSection() {
  const [budget, setBudget] = useState<number | null>(null);
  const [today, setToday] = useState<number>(0);
  const [blocked, setBlocked] = useState<boolean>(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    // 当日消費は変化するので定期的に再取得 (30s)。
    const t = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(t);
  }, []);

  async function refresh() {
    try {
      const s = (await fetch("/v1/admin/cost-budget").then((r) => r.json())) as {
        daily_token_budget: number; today_tokens: number; blocked: boolean;
      };
      setBudget(s.daily_token_budget);
      setToday(s.today_tokens);
      setBlocked(s.blocked);
      setDraft(String(s.daily_token_budget));
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function apply() {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 0) { setError("0 以上の数値を入力"); return; }
    setBusy(true); setError(null);
    try {
      await putJson("/v1/admin/cost-budget", { daily_token_budget: Math.floor(n) });
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const pct = budget && budget > 0 ? Math.min(100, Math.round((today / budget) * 100)) : 0;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-sm">コスト予算 (日次トークン)</h2>
        <p className="text-subtle text-xs mt-0.5">
          当日 (ローカル日) のトークン消費合計が上限に達したら、 Concordia 発の命令
          (新規 spawn / dispatcher 発話 / リアクションWF / rule engine) を止める。
          外部バッチ・別ツール起動の Claude/Codex も合算対象。 0 = 無効。
        </p>
      </div>

      <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-subtle">当日消費:</span>
          <span className="font-mono">{today.toLocaleString()} tok</span>
          <span className="text-subtle">/ 予算:</span>
          <span className="font-mono">{budget === null ? "..." : budget === 0 ? "(無効)" : budget.toLocaleString()}</span>
          {blocked && (
            <span className="px-2 py-0.5 rounded text-xs border bg-danger/20 border-danger text-danger">
              ⛔ ブロック中
            </span>
          )}
        </div>
        {budget !== null && budget > 0 && (
          <div className="h-2 w-full rounded bg-muted overflow-hidden">
            <div
              className={`h-full ${blocked ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-ok"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-subtle shrink-0">上限 (tok):</span>
          <input
            type="number"
            min={0}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            placeholder="0 = 無効 (例 2000000)"
            className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono flex-1 min-w-[160px]"
          />
          <button
            disabled={busy || draft === String(budget ?? "")}
            onClick={() => void apply()}
            className="shrink-0 px-3 py-1 bg-accent/15 border border-accent text-accent rounded text-xs disabled:opacity-40"
          >
            apply
          </button>
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}
