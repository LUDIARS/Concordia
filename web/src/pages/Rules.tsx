import { useEffect, useState } from "react";
import { RuleEditor } from "./rules/RuleEditor.js";
import { RuleList } from "./rules/RuleList.js";
import { RunHistory } from "./rules/RunHistory.js";
import { fmtSec, rulesApi, type RuleView, type SourceView, type SubsidiaryOption } from "./rules/rules-api.js";
import { SubsidiaryDefaults } from "./rules/SubsidiaryDefaults.js";

// ルールと巡回チャット (spec/feature/patrol-chat.md §9)。 上部にエンジンの ON/OFF と素材元の状態、
// 下に「ルール」と「実行履歴」。 候補不足・認証不足を保存成功と混同しないよう、 素材元の状態を常に出す。

type Tab = "rules" | "runs";

export function Rules() {
  const [tab, setTab] = useState<Tab>("rules");
  const [rules, setRules] = useState<RuleView[]>([]);
  const [sources, setSources] = useState<SourceView[]>([]);
  const [engineOn, setEngineOn] = useState<boolean | null>(null);
  const [editing, setEditing] = useState<RuleView | "new" | null>(null);
  const [runRuleId, setRunRuleId] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** "" = 全社、 "hq" = 本社、 それ以外は子会社 ID。 */
  const [owner, setOwner] = useState("");
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryOption[]>([]);

  const refresh = async () => {
    const [r, s, e] = await Promise.all([rulesApi.list(owner), rulesApi.sources(), rulesApi.engineEnabled()]);
    if (r.ok) setRules(r.data.rules);
    if (s.ok) setSources(s.data.sources);
    if (e.ok) setEngineOn(e.data.enabled);
    setError(!r.ok ? r.error : !s.ok ? s.error : null);
  };

  useEffect(() => { void refresh(); }, [owner]);
  useEffect(() => {
    // 子会社の一覧が取れない環境 (子会社機能なし) では持ち主の絞り込みを出さない。
    void rulesApi.subsidiaries().then((res) => { if (res.ok) setSubsidiaries(res.data.subsidiaries); });
  }, []);
  const ownerSubsidiary = subsidiaries.find((s) => s.id === owner) ?? null;

  const toggleEngine = async () => {
    if (engineOn === null) return;
    const res = await rulesApi.setEngineEnabled(!engineOn);
    if (res.ok) setEngineOn(res.data.enabled);
  };

  return (
    <div className="space-y-4 max-w-6xl">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">ルールと巡回チャット</h1>
        <p className="text-subtle text-sm">
          決まったルールで素材を選び、 チャットへ短い一言を投稿します。 返信にはすぐ応え、 反応や後続の発言が多いときだけ一度だけ追投稿します。
          発火や選択に AI は使わず、 文を作るときだけ 1 回使います。
        </p>
      </header>

      <section className="flex flex-wrap gap-3 items-start text-sm">
        <div className="border border-border rounded px-3 py-2 space-y-1">
          <div className="text-[11px] text-subtle">ルールエンジン</div>
          <div className="flex items-center gap-2">
            <span data-testid="engine-state">{engineOn === null ? "—" : engineOn ? "ON" : "OFF"}</span>
            <button type="button" className="px-2 py-1 rounded border border-border text-xs" onClick={() => void toggleEngine()}>
              {engineOn ? "止める" : "動かす"}
            </button>
          </div>
          <div className="text-[11px] text-subtle">コスト予算を超えている間も止まります</div>
        </div>
        {sources.map((s) => (
          <div key={s.sourceId} className="border border-border rounded px-3 py-2 space-y-1" data-testid={`source-${s.sourceId}`}>
            <div className="text-[11px] text-subtle">素材元</div>
            <div>{s.label}</div>
            <div className="text-xs">{s.status === "ready" ? "接続可" : `使えません (${s.reason})`}</div>
            <div className="text-[11px] text-subtle">
              最終取得 {s.lastFetchedAt ? fmtSec(Math.floor(Date.parse(s.lastFetchedAt) / 1000)) : "—"}
              {s.lastError ? ` · ${s.lastError}` : ""}
            </div>
          </div>
        ))}
      </section>

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      <nav className="flex gap-2 text-sm" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "rules"} className={`px-3 py-1 rounded ${tab === "rules" ? "bg-accent text-white" : "border border-border"}`} onClick={() => setTab("rules")}>ルール</button>
        <button type="button" role="tab" aria-selected={tab === "runs"} className={`px-3 py-1 rounded ${tab === "runs" ? "bg-accent text-white" : "border border-border"}`} onClick={() => setTab("runs")}>実行履歴</button>
      </nav>

      {tab === "rules" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {subsidiaries.length > 0 && (
              <label className="flex items-center gap-1 text-sm">
                <span className="text-[11px] text-subtle">持ち主</span>
                <select className="foundation-form text-sm" aria-label="持ち主" value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">すべて</option>
                  <option value="hq">本社</option>
                  {subsidiaries.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
                </select>
              </label>
            )}
            <button type="button" className="px-3 py-1 rounded border border-border text-sm" onClick={() => setEditing("new")}>巡回ルールを追加</button>
          </div>
          {ownerSubsidiary && <SubsidiaryDefaults key={ownerSubsidiary.id} subsidiary={ownerSubsidiary} />}
          {editing && (
            <RuleEditor
              key={editing === "new" ? "new" : `${editing.id}:${editing.revision}`}
              rule={editing === "new" ? null : editing}
              sources={sources}
              subsidiaries={subsidiaries}
              defaultOwner={owner === "" || owner === "hq" ? null : owner}
              onSaved={() => { setEditing(null); void refresh(); }}
              onCancel={() => setEditing(null)}
            />
          )}
          <RuleList
            subsidiaries={subsidiaries}
            rules={rules}
            onEdit={(r) => setEditing(r)}
            onChanged={() => void refresh()}
            onShowRuns={(id) => { setRunRuleId(id); setTab("runs"); }}
          />
        </div>
      ) : (
        <RunHistory ruleId={runRuleId} onRuleIdChange={setRunRuleId} />
      )}
    </div>
  );
}
