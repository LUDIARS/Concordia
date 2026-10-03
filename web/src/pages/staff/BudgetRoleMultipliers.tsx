import { useEffect, useState } from "react";

import { api, type UsageBudgetDiscordRoleGuild, type UsageBudgetRoleMultiplier } from "../../api.js";

// 月次予算の属性 (Discord のロール) ごとのコスト倍率 (spec/feature/usage-budgets.md §3.1 §6)。
// 消費 × 部署の倍率 × 消費した人のロールの倍率を予算から引く。 複数のロールを持つ人は、 倍率を設定したロールの
// いちばん低い倍率を使う。 空欄で保存すると倍率を外す (1)。

type RoleMultiplierClient = Pick<
  typeof api,
  "usageBudgetRoleMultipliers" | "usageBudgetDiscordRoles" | "usageBudgetRoleMultiplierSet" | "usageBudgetRoleMultiplierRemove"
>;

function MultiplierInput({
  roleId,
  guildId,
  label,
  current,
  onChanged,
  client,
}: {
  roleId: string;
  guildId: string;
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
      if (trimmed) await client.usageBudgetRoleMultiplierSet(roleId, guildId, multiplier);
      else await client.usageBudgetRoleMultiplierRemove(roleId);
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

/** 倍率が設定されているのに、 今の guild のロール一覧に無いロール (消されたロール・Bot 停止中)。 外せるように出す。 */
function unlistedRows(rows: UsageBudgetRoleMultiplier[], guilds: UsageBudgetDiscordRoleGuild[]): UsageBudgetRoleMultiplier[] {
  const listed = new Set(guilds.flatMap((guild) => guild.roles.map((role) => role.id)));
  return rows.filter((row) => !listed.has(row.role_id));
}

/** client はテストが偽物を渡す口 (vitest のモジュール共有で vi.mock が他ファイルのモックに負けるため)。 */
export function BudgetRoleMultipliers({ client = api }: { client?: RoleMultiplierClient } = {}) {
  const [rows, setRows] = useState<UsageBudgetRoleMultiplier[] | null>(null);
  const [guilds, setGuilds] = useState<UsageBudgetDiscordRoleGuild[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [multipliers, roles] = await Promise.all([client.usageBudgetRoleMultipliers(), client.usageBudgetDiscordRoles()]);
      setRows(multipliers.multipliers);
      setGuilds(roles.guilds);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => { void refresh(); }, []);

  const currentOf = (roleId: string) => rows?.find((row) => row.role_id === roleId)?.multiplier ?? null;
  const unlisted = rows ? unlistedRows(rows, guilds) : [];

  return (
    <section className="bg-surface border border-border rounded p-3 space-y-2">
      <div className="text-sm font-semibold">月の予算のコスト倍率 (Discord のロールごと)</div>
      <p className="text-[11px] text-subtle">
        予算から引く額 = 消費トークン × 部署の倍率 × 消費した人のロールの倍率。 複数のロールを持つ人は倍率を設定したロールのいちばん低い倍率を使います。
        チームの予算から引くときは指示を出した人のロールを使います。 空欄は 1。
      </p>
      {error && <div className="text-[11px] text-danger">{error}</div>}
      {rows && guilds.length === 0 && (
        <div className="text-[11px] text-subtle">Discord のロールを読めません (Bot が停止中か、 在籍する guild がありません)。</div>
      )}
      {rows && guilds.map((guild) => (
        <div key={guild.guild_id} className="space-y-1">
          <div className="text-xs font-semibold">{guild.guild_name}</div>
          <div className="flex flex-wrap gap-4">
            {guild.roles.map((role) => (
              <MultiplierInput
                key={role.id}
                roleId={role.id}
                guildId={guild.guild_id}
                label={`${guild.guild_name} / ${role.name}`}
                current={currentOf(role.id)}
                onChanged={() => { void refresh(); }}
                client={client}
              />
            ))}
          </div>
        </div>
      ))}
      {unlisted.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-semibold">一覧に無いロール</div>
          <div className="flex flex-wrap gap-4">
            {unlisted.map((row) => (
              <MultiplierInput
                key={row.role_id}
                roleId={row.role_id}
                guildId={row.guild_id}
                label={`ロール ${row.role_id}`}
                current={row.multiplier}
                onChanged={() => { void refresh(); }}
                client={client}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
