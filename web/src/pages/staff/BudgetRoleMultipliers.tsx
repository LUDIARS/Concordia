import { useEffect, useState } from "react";

import { api, type StaffRole, type UsageBudgetRoleMultiplier } from "../../api.js";

// 月次予算の属性 (役職) ごとのコスト倍率 (spec/feature/usage-budgets.md §3.1 §6)。
// 消費 × 部署の倍率 × 消費した人の役職の倍率を予算から引く。 空欄で保存すると倍率を外す (1)。

const ROLES: Array<{ value: StaffRole; label: string }> = [
  { value: "staff", label: "ヒラ社員" },
  { value: "manager", label: "管理職" },
  { value: "executive", label: "執行役員" },
];

type RoleMultiplierClient = Pick<typeof api, "usageBudgetRoleMultipliers" | "usageBudgetRoleMultiplierSet" | "usageBudgetRoleMultiplierRemove">;

function MultiplierInput({
  role,
  label,
  current,
  onChanged,
  client,
}: {
  role: StaffRole;
  label: string;
  current: number | null;
  onChanged: () => void;
  client: RoleMultiplierClient;
}) {
  const [value, setValue] = useState(current === null ? "" : String(current));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValue(current === null ? "" : String(current)); }, [current]);

  async function commit() {
    const trimmed = value.trim();
    if (trimmed === (current === null ? "" : String(current))) return;
    const multiplier = Number(trimmed);
    if (trimmed && (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 10)) {
      setError("0 より大きく 10 以下");
      return;
    }
    setBusy(true);
    try {
      if (trimmed) await client.usageBudgetRoleMultiplierSet(role, multiplier);
      else await client.usageBudgetRoleMultiplierRemove(role);
      setError(null);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="flex flex-col gap-0.5 text-xs">
      <span className="text-subtle">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={`${label}の予算のコスト倍率`}
        value={value}
        disabled={busy}
        placeholder="1"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { void commit(); }}
        className="foundation-form text-sm w-20"
      />
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </label>
  );
}

/** client はテストが偽物を渡す口 (vitest のモジュール共有で vi.mock が他ファイルのモックに負けるため)。 */
export function BudgetRoleMultipliers({ client = api }: { client?: RoleMultiplierClient } = {}) {
  const [rows, setRows] = useState<UsageBudgetRoleMultiplier[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setRows((await client.usageBudgetRoleMultipliers()).multipliers);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => { void refresh(); }, []);

  return (
    <section className="bg-surface border border-border rounded p-3 space-y-2">
      <div className="text-sm font-semibold">月の予算のコスト倍率 (役職ごと)</div>
      <p className="text-[11px] text-subtle">
        予算から引く額 = 消費トークン × 部署の倍率 × 消費した人の役職の倍率。 チームの予算から引くときは指示を出した人の役職を使います。 空欄は 1。
      </p>
      {error && <div className="text-[11px] text-danger">{error}</div>}
      {rows && (
        <div className="flex gap-4">
          {ROLES.map((role) => (
            <MultiplierInput
              key={role.value}
              role={role.value}
              label={role.label}
              current={rows.find((row) => row.role === role.value)?.multiplier ?? null}
              onChanged={() => { void refresh(); }}
              client={client}
            />
          ))}
        </div>
      )}
    </section>
  );
}
