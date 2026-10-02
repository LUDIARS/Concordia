import { useEffect, useState } from "react";

import { api, type UsageBudget, type UsageBudgetScope } from "../api.js";

// 月次トークン予算の編集 (spec/feature/usage-budgets.md §6)。 社員名簿の行とチームのコスト画面で使う。
// 空欄で保存すると予算を外す (無制限)。 消費は今月に始まったセッションの累積トークン。

export function UsageBudgetEditor({
  scope,
  targetId,
  budget,
  onChanged,
}: {
  scope: UsageBudgetScope;
  targetId: string;
  budget: UsageBudget | null;
  onChanged: () => void;
}) {
  const [value, setValue] = useState(budget ? String(budget.limit_tokens) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setValue(budget ? String(budget.limit_tokens) : ""); }, [budget?.limit_tokens]);

  async function commit() {
    const trimmed = value.trim();
    if (trimmed === (budget ? String(budget.limit_tokens) : "")) return;
    const limit = Number(trimmed);
    if (trimmed && (!Number.isInteger(limit) || limit < 0)) {
      setError("0 以上の整数で入力してください");
      return;
    }
    setBusy(true);
    try {
      if (trimmed) await api.usageBudgetSet(scope, targetId, limit);
      else await api.usageBudgetRemove(scope, targetId);
      setError(null);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const percent = budget ? Math.min(999, Math.floor(budget.ratio * 100)) : null;
  return (
    <div className="flex flex-col gap-0.5">
      <input
        type="text"
        inputMode="numeric"
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { void commit(); }}
        placeholder="無制限"
        title="月の上限トークン。空欄で無制限"
        className="foundation-form text-sm w-28"
      />
      {budget && (
        <span className={`text-[11px] ${budget.exhausted ? "text-danger" : percent !== null && percent >= 80 ? "text-warn" : "text-subtle"}`}>
          今月 {budget.consumed_tokens.toLocaleString()} ({percent}%)
        </span>
      )}
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </div>
  );
}
