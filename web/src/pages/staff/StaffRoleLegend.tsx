import type { StaffListResult } from "../../api.js";

// 役職 → 何ができるか の凡例。 backend の固定表 (src/staff/roles.ts) をそのまま描くので、
// フロントに権限ロジックは持たない (判定源を二重化しないため)。

export function StaffRoleLegend({ data }: { data: StaffListResult }) {
  return (
    <details className="bg-muted/40 border border-border rounded p-3">
      <summary className="text-sm font-medium cursor-pointer">
        役職と権限 — どの役職で何ができるか
      </summary>
      <p className="text-xs text-subtle mt-1">
        権限は 3 段階固定です。 操作ごとの細かい設定は持たず、 この表だけで決まります。
        名簿に無いユーザは ヒラ社員 と同じ扱い (会話はできる / 権限操作は Deny)。
      </p>

      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {data.roles.map((role) => (
          <div key={role.role} className="bg-surface border border-border rounded p-2">
            <div className="text-sm font-medium">{role.label}</div>
            <ul className="mt-1 space-y-0.5">
              {role.capabilities.map((capability) => (
                <li key={capability.capability} className="text-[11px] text-subtle">
                  ・{capability.label}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-3">
        <div className="text-xs font-medium">操作ごとの必要役職</div>
        <ul className="mt-1 space-y-1">
          {data.capabilities.map((capability) => (
            <li
              key={capability.capability}
              className="flex items-center gap-2 bg-surface border border-border rounded px-2 py-1 text-xs"
            >
              <span className="flex-1">{capability.label}</span>
              <span className="font-mono text-[10px] text-subtle">{capability.capability}</span>
              <span className="text-accent">{capability.min_role_label} 以上</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
