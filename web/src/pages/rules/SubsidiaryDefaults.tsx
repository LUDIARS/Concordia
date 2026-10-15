import { useEffect, useState } from "react";
import { fmtSec, rulesApi, type PatrolDefaults, type SubsidiaryOption } from "./rules-api.js";

// 子会社ごとの巡回の既定値 (spec/plan/2026-10-15-patrol-subsidiary-rules-design.md §2)。
// ルール側で指定していない項目はここを引き継ぐ。 子会社のサーバー管理者は Discord の /patrol defaults-set でも変えられる。

export function SubsidiaryDefaults({ subsidiary }: { subsidiary: SubsidiaryOption }) {
  const [defaults, setDefaults] = useState<PatrolDefaults>({});
  const [meta, setMeta] = useState<{ updated_at: number | null; updated_by: string | null }>({ updated_at: null, updated_by: null });
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void rulesApi.patrolDefaults(subsidiary.id).then((res) => {
      if (res.ok) {
        setDefaults(res.data.defaults);
        setMeta({ updated_at: res.data.updated_at, updated_by: res.data.updated_by });
      } else setMessage(res.error);
    });
  }, [subsidiary.id]);

  const patch = (p: PatrolDefaults) => setDefaults((d) => ({ ...d, ...p }));
  const save = async () => {
    const res = await rulesApi.setPatrolDefaults(subsidiary.id, defaults);
    setMessage(res.ok ? "保存しました" : `保存できません: ${res.error}`);
  };
  const quiet = defaults.quiet_hours;

  return (
    <section className="border border-border rounded p-3 space-y-2 text-sm" data-testid="subsidiary-defaults">
      <h3 className="font-semibold">{subsidiary.display_name} の既定値</h3>
      <p className="text-xs text-subtle">
        この子会社のルールで指定していない項目に効きます。 最終更新 {meta.updated_by ?? "—"} {fmtSec(meta.updated_at)}
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={defaults.paused === true} onChange={(e) => patch({ paused: e.target.checked })} />
        この子会社の巡回をまるごと止める (返信も含む)
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-subtle">新規投稿しない時間帯</span>
        <select
          className="foundation-form text-sm"
          aria-label="既定の時間帯"
          value={quiet === undefined ? "unset" : quiet === null ? "none" : "set"}
          onChange={(e) => {
            const v = e.target.value;
            setDefaults((d) => {
              const next = { ...d };
              if (v === "unset") delete next.quiet_hours;
              else next.quiet_hours = v === "none" ? null : { start: "22:00", end: "09:30" };
              return next;
            });
          }}
        >
          <option value="unset">未設定 (時間帯なし)</option>
          <option value="none">時間帯なし</option>
          <option value="set">指定する</option>
        </select>
        {quiet && (
          <>
            <input type="time" aria-label="既定の開始" className="foundation-form text-sm" value={quiet.start}
              onChange={(e) => patch({ quiet_hours: { ...quiet, start: e.target.value } })} />
            <span>〜</span>
            <input type="time" aria-label="既定の終了" className="foundation-form text-sm" value={quiet.end}
              onChange={(e) => patch({ quiet_hours: { ...quiet, end: e.target.value } })} />
          </>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">1 日の投稿上限 (空なら 8)</span>
          <input type="number" min={1} max={48} className="foundation-form text-sm w-full" value={defaults.root_limit_per_day ?? ""}
            onChange={(e) => setDefaults((d) => {
              const next = { ...d };
              if (e.target.value === "") delete next.root_limit_per_day;
              else next.root_limit_per_day = Number(e.target.value);
              return next;
            })} />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">投稿先の Discord チャンネル ID</span>
          <input className="foundation-form text-sm w-full" value={defaults.discord_channel_id ?? ""}
            onChange={(e) => patch({ discord_channel_id: e.target.value.trim() || null })} />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">名前の雰囲気</span>
          <input className="foundation-form text-sm w-full" value={defaults.persona_hint ?? ""} placeholder="例: 学校らしく"
            onChange={(e) => patch({ persona_hint: e.target.value.trim() || null })} />
        </label>
      </div>
      {message && <p className="text-xs" role="status">{message}</p>}
      <button type="button" className="px-3 py-1 rounded bg-accent text-white text-sm" onClick={() => void save()}>既定値を保存</button>
    </section>
  );
}
