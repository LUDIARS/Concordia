import { useState } from "react";
import { LearningLog } from "./LearningLog.js";
import { fmtSec, rulesApi, RUN_STATUS_LABEL, type LearningRunView, type PreviewView, type RuleView, type SubsidiaryOption, type VersionView } from "./rules-api.js";

// ルール一覧 (spec/feature/patrol-chat.md §9)。 旧ルールは legacy-observe (投稿しない) と明示する。
// 試し見は副作用・生成なしで候補と理由を出す。 rollback は設定だけを戻し、 過去の投稿は変えない。

interface Props {
  rules: RuleView[];
  /** 持ち主の表示名 (未取得なら ID のまま出す)。 */
  subsidiaries?: SubsidiaryOption[];
  onEdit: (rule: RuleView) => void;
  onChanged: () => void;
  onShowRuns: (ruleId: string) => void;
}

function triggerLabel(r: RuleView): string {
  if (r.trigger_type === "tick") return `定期 ${r.tick_sec ?? "?"} 秒`;
  return r.event_kind === "service.event" ? "サービスの出来事" : `event ${r.event_kind ?? "*"}`;
}

export function RuleList({ rules, subsidiaries = [], onEdit, onChanged, onShowRuns }: Props) {
  const ownerName = (id: string | null | undefined) =>
    id ? subsidiaries.find((s) => s.id === id)?.display_name ?? id : "本社";
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; view: PreviewView } | null>(null);
  const [versions, setVersions] = useState<{ rule: RuleView; rows: VersionView[] } | null>(null);
  const [learning, setLearning] = useState<{ id: string; runs: LearningRunView[] } | null>(null);
  const active = rules.filter((r) => !r.removed_at);

  const toggle = async (r: RuleView) => {
    const res = await rulesApi.toggle(r.id);
    setMessage(res.ok ? null : `${r.id}: ${res.error}`);
    onChanged();
  };
  const runPreview = async (r: RuleView) => {
    const res = await rulesApi.preview({ rule_id: r.id });
    if (res.ok) setPreview({ id: r.id, view: res.data.preview });
    else setMessage(`${r.id}: ${res.error}`);
  };
  const showVersions = async (r: RuleView) => {
    const res = await rulesApi.versions(r.id);
    if (res.ok) setVersions({ rule: r, rows: res.data.versions });
  };
  const showLearning = async (r: RuleView) => {
    const res = await rulesApi.learning(r.id);
    if (res.ok) setLearning({ id: r.id, runs: res.data.runs });
    else setMessage(`${r.id}: ${res.error}`);
  };
  const rollback = async (rule: RuleView, to: number) => {
    const res = await rulesApi.rollback(rule.id, rule.revision, to);
    setMessage(res.ok ? `${rule.id}: rev ${to} の設定に戻しました (新しい版として保存)` : `${rule.id}: ${res.error}`);
    setVersions(null);
    onChanged();
  };

  return (
    <div className="space-y-3">
      {message && <p className="text-sm" role="status">{message}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] text-subtle">
            <tr>
              <th className="py-1 pr-2">ルール</th>
              <th className="py-1 pr-2">方式</th>
              <th className="py-1 pr-2">きっかけ</th>
              <th className="py-1 pr-2">素材元 / 宛先</th>
              <th className="py-1 pr-2">上限 / 生成</th>
              <th className="py-1 pr-2">最終結果</th>
              <th className="py-1 pr-2">状態</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {active.map((r) => (
              <tr key={r.id} className="border-t border-border align-top" data-testid={`rule-row-${r.id}`}>
                <td className="py-1 pr-2">
                  <div className="font-medium">{r.id}</div>
                  <div className="text-xs text-subtle">{r.description ?? ""} (rev {r.revision})</div>
                  {r.execution_mode === "patrol" && <div className="text-xs text-subtle">持ち主: {ownerName(r.subsidiary_id)}</div>}
                </td>
                <td className="py-1 pr-2 text-xs">{r.execution_mode === "patrol" ? "巡回" : "legacy-observe (投稿しない)"}</td>
                <td className="py-1 pr-2 text-xs">{triggerLabel(r)}</td>
                <td className="py-1 pr-2 text-xs">
                  {r.action_config ? `${r.action_config.source_ids.join(", ") || "—"} → ${r.target ?? "chitchat"} (${r.action_config.scope_key})` : r.target ?? "—"}
                  {r.action_config?.filters.genres?.length ? <div className="text-subtle">ジャンル: {r.action_config.filters.genres.join(", ")}</div> : null}
                  {r.action_config?.filters.service_codes?.length ? <div className="text-subtle">サービス: {r.action_config.filters.service_codes.join(", ")}</div> : null}
                </td>
                <td className="py-1 pr-2 text-xs">
                  {r.action_config
                    ? `${r.effective_config?.root_limit_per_day ?? r.action_config.root_limit_per_day ?? "?"}/日 · ${r.action_config.renderer === "oneshot" ? "短文生成" : "決まった型"}`
                    : "—"}
                  {r.effective_config?.quiet_hours && (
                    <div className="text-subtle">{r.effective_config.quiet_hours.start}〜{r.effective_config.quiet_hours.end} は新規投稿しない</div>
                  )}
                </td>
                <td className="py-1 pr-2 text-xs">
                  {r.last_run ? (
                    <button type="button" className="underline text-left" onClick={() => onShowRuns(r.id)}>
                      {RUN_STATUS_LABEL[r.last_run.status] ?? r.last_run.status}
                      {r.last_run.reason ? ` — ${r.last_run.reason}` : ""}
                    </button>
                  ) : "—"}
                  <div className="text-subtle">次回 {fmtSec(r.next_due_at)}</div>
                </td>
                <td className="py-1 pr-2 text-xs">
                  <div>{r.enabled ? "有効" : "無効"}</div>
                  {!r.readiness.runnable && r.readiness.reason !== "disabled" && <div className="text-subtle">{r.readiness.reason}</div>}
                </td>
                <td className="py-1 text-xs whitespace-nowrap space-x-1">
                  <button type="button" className="px-2 py-1 rounded border border-border" onClick={() => void toggle(r)}>{r.enabled ? "無効化" : "有効化"}</button>
                  <button type="button" className="px-2 py-1 rounded border border-border" onClick={() => onEdit(r)}>{r.execution_mode === "patrol" ? "編集" : "巡回へ移す"}</button>
                  {r.execution_mode === "patrol" && (
                    <>
                      <button type="button" className="px-2 py-1 rounded border border-border" onClick={() => void runPreview(r)}>試し見</button>
                      <button type="button" className="px-2 py-1 rounded border border-border" onClick={() => void showVersions(r)}>版</button>
                      <button type="button" className="px-2 py-1 rounded border border-border" onClick={() => void showLearning(r)}>学習</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {active.length === 0 && <p className="text-sm text-subtle py-2">ルールがありません。</p>}
      </div>

      {preview && (
        <section className="border border-border rounded p-3 space-y-1 text-sm" data-testid="rule-preview">
          <h3 className="font-semibold">試し見: {preview.id} (投稿・生成はしていません)</h3>
          <p>{preview.view.ok ? "選ばれる話題" : "投稿されない理由"}: {preview.view.reason}</p>
          {preview.view.picked && (
            <p>
              「{preview.view.picked.title}」 {preview.view.picked.excerpt}
              {preview.view.picked.url && <> <a className="underline" href={preview.view.picked.url} target="_blank" rel="noreferrer">出典</a></>}
            </p>
          )}
          <p className="text-xs text-subtle">候補 {preview.view.candidateCount} 件 · seed {preview.view.seed}</p>
          {preview.view.sourceErrors.map((e) => <p key={e.sourceId} className="text-xs text-red-600">{e.sourceId}: {e.code} — {e.message}</p>)}
          <button type="button" className="text-xs underline" onClick={() => setPreview(null)}>閉じる</button>
        </section>
      )}

      {learning && <LearningLog ruleId={learning.id} runs={learning.runs} onClose={() => setLearning(null)} />}

      {versions && (
        <section className="border border-border rounded p-3 space-y-1 text-sm" data-testid="rule-versions">
          <h3 className="font-semibold">版の履歴: {versions.rule.id}</h3>
          <ul className="space-y-1">
            {versions.rows.map((v) => (
              <li key={v.revision} className="text-xs flex items-center gap-2">
                <span>rev {v.revision} · {v.note ?? ""} · {v.actor} · {fmtSec(v.created_at)}</span>
                {v.revision !== versions.rule.revision && (
                  <button type="button" className="underline" onClick={() => void rollback(versions.rule, v.revision)}>この設定に戻す</button>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="text-xs underline" onClick={() => setVersions(null)}>閉じる</button>
        </section>
      )}
    </div>
  );
}
