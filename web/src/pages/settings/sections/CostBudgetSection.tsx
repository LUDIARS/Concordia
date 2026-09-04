// 設定ページの各セクション。Settings.tsx が左メニューで切り替えて表示する。
// web-hosts: Vite allowedHosts を concordia.config.json 経由で管理。
// runtime kill switch (chat-mute / rules-enabled) は旧 Rules ページの
// AdminTogglesPanel から移設。reaction-workflow / workspace / Lictor は新規。

import { useEffect, useState } from "react";

// ─── コスト予算 (日次トークン上限 + 超過ブロック) ────────────────────────
//
// 上限値は設定レジストリ (`runtime.daily_token_budget`) に editable で載っている。
// ここにも入力欄を置くと同じ DB キーを 2 経路から書けてしまうので、 本セクションは
// 当日消費・ブロック状態という**ここでしか見られない情報**の表示に徹する。

/** @implements spec/tasks/2026-08-09-settings-duplicate-display-cleanup.md */
export function CostBudgetSection({ onOpenAllSettings }: { onOpenAllSettings: () => void }) {
  const [budget, setBudget] = useState<number | null>(null);
  const [today, setToday] = useState<number>(0);
  const [blocked, setBlocked] = useState<boolean>(false);
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
      setError(null);
    } catch (err) { setError((err as Error).message); }
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
        <p className="text-subtle text-xs">
          上限の変更は <strong>設定 &gt; すべて</strong> で行う (<code>runtime.daily_token_budget</code>)。
          {" "}
          <button
            type="button"
            onClick={onOpenAllSettings}
            className="underline text-accent hover:text-accent/80"
          >
            すべての設定を開く
          </button>
        </p>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}
