import { useEffect, useState } from "react";
import { ACTION_LABEL, fmtSec, rulesApi, RUN_STATUS_LABEL, type RunDetail, type RunView } from "./rules-api.js";

// 実行履歴 (spec/feature/patrol-chat.md §9)。 選んだ素材と出典・投稿本文・見送り/失敗の理由、
// Cc への投稿と Discord への配達の区別、 返信・追投稿の状況を出す。 ページングは cursor。

const STATUSES = Object.keys(RUN_STATUS_LABEL);

export function RunHistory({ ruleId, onRuleIdChange }: { ruleId: string; onRuleIdChange: (id: string) => void }) {
  const [status, setStatus] = useState("");
  const [runs, setRuns] = useState<RunView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<RunDetail | null>(null);

  const load = async (more: boolean) => {
    setLoading(true);
    const res = await rulesApi.runs({ rule_id: ruleId || undefined, status: status || undefined, cursor: more ? cursor : null });
    setLoading(false);
    if (!res.ok) { setError(res.error); return; }
    setError(null);
    setRuns((prev) => (more ? [...prev, ...res.data.runs] : res.data.runs));
    setCursor(res.data.next_cursor);
  };

  useEffect(() => { void load(false); }, [ruleId, status]);

  const open = async (runId: string) => {
    const res = await rulesApi.run(runId);
    if (res.ok) setDetail(res.data);
    else setError(res.error);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-end">
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">ルール ID</span>
          <input className="foundation-form text-sm" value={ruleId} onChange={(e) => onRuleIdChange(e.target.value)} placeholder="すべて" />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">状態</span>
          <select className="foundation-form text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">すべて</option>
            {STATUSES.map((s) => <option key={s} value={s}>{RUN_STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <button type="button" className="px-2 py-1 rounded border border-border text-xs" onClick={() => void load(false)}>読み直す</button>
      </div>
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      <ul className="divide-y divide-border text-sm" data-testid="run-list">
        {runs.map((r) => (
          <li key={r.run_id} className="py-2">
            <button type="button" className="text-left w-full" onClick={() => void open(r.run_id)}>
              <div className="flex flex-wrap gap-x-2 text-xs text-subtle">
                <span>{fmtSec(r.created_at)}</span>
                <span>{r.rule_id} rev {r.rule_revision}</span>
                <span>{ACTION_LABEL[r.action_kind]}</span>
                <span className="font-medium text-current">{RUN_STATUS_LABEL[r.status] ?? r.status}</span>
              </div>
              {r.rendered_text && <div className="mt-1">{r.rendered_text}</div>}
              {!r.rendered_text && r.reason && <div className="mt-1 text-subtle">{r.reason}</div>}
              {r.material?.title && <div className="text-xs text-subtle">素材: {r.material.title}</div>}
            </button>
          </li>
        ))}
      </ul>
      {!loading && runs.length === 0 && <p className="text-sm text-subtle">実行履歴はまだありません。</p>}
      {cursor && <button type="button" className="px-2 py-1 rounded border border-border text-xs" disabled={loading} onClick={() => void load(true)}>さらに読む</button>}

      {detail && (
        <section className="border border-border rounded p-3 space-y-1 text-sm" data-testid="run-detail">
          <h3 className="font-semibold">実行 {detail.run.run_id}</h3>
          <p>状態: {RUN_STATUS_LABEL[detail.run.status] ?? detail.run.status}{detail.run.error_code ? ` (${detail.run.error_code})` : ""}</p>
          <p className="text-xs text-subtle">きっかけ: {detail.run.trigger_key} · 宛先 {detail.run.channel} ({detail.run.scope_key})</p>
          {detail.run.reason && <p>理由: {detail.run.reason}</p>}
          {detail.run.material && (
            <p>
              素材: {detail.run.material.title} {detail.run.material.excerpt}
              {detail.run.material.url && <> <a className="underline" href={detail.run.material.url} target="_blank" rel="noreferrer">出典</a></>}
            </p>
          )}
          {detail.run.decision?.candidateCount !== undefined && (
            <p className="text-xs text-subtle">候補 {detail.run.decision.candidateCount} 件 · seed {detail.run.seed ?? "—"}</p>
          )}
          {detail.run.decision?.knowledge && detail.run.decision.knowledge.length > 0 && (
            <div className="text-xs" data-testid="run-knowledge">
              <p>使った知識:</p>
              <ul className="list-disc pl-5">
                {detail.run.decision.knowledge.map((k, i) => (
                  <li key={`${k.title}:${i}`}>
                    {k.url ? <a className="underline" href={k.url} target="_blank" rel="noreferrer">{k.title}</a> : k.title}
                    {k.path ? ` (${k.repo ?? ""} ${k.path})` : ""}
                    {k.scope === "hq" ? " · 本社限定" : " · 公開"}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.run.rendered_text && <p>本文: {detail.run.rendered_text}</p>}
          <p className="text-xs">
            Cc への投稿: {detail.run.chat_message_id ? `#${detail.run.chat_message_id}` : "なし"} · 配達: {detail.run.delivery_ref ?? (detail.run.status === "delivery_unknown" ? "結果不明 (自動では再送しません)" : "未確認")}
          </p>
          <p className="text-xs text-subtle">生成 {detail.run.render_attempts} 回 · LLM 呼出し {detail.run.llm_calls} 回</p>
          {detail.conversation && (
            <p className="text-xs">
              会話: 返信への応答 {detail.conversation.reply_count} 回 · 追投稿 {detail.conversation.unprompted_count} 回 ·
              受けた返信 {detail.conversation.inbound.length} 件 · {detail.conversation.status === "open" ? `受付中 (〜${fmtSec(detail.conversation.expires_at)})` : "終了"}
            </p>
          )}
          {detail.rule_version && <p className="text-xs text-subtle">実行時の設定: rev {detail.rule_version.revision}</p>}
          <button type="button" className="text-xs underline" onClick={() => setDetail(null)}>閉じる</button>
        </section>
      )}
    </div>
  );
}
