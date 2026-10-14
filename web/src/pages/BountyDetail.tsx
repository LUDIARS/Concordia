// @implements SPEC-BOUNTY-WEBUI
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, type BountyJudgementChange, type BountyReportDetail } from "../api.js";
import { BOUNTY_STATUS_LABEL, formatTime } from "./Bounty.js";

// バグ報告の詳細 (spec/feature/bug-bounty.md §8.2)。 原文・仕分けの根拠・履歴・Actio タスク・PR・反映の証拠を出し、
// 権限者の操作 (判定・深刻度・自己起因の変更、再審の決定、タスク作成の再試行、手動クローズ) を use case の API で行う。
// 原文は運用担当の管理面にだけ出す。

const VERDICTS = [
  { value: "accepted", label: "採用" },
  { value: "duplicate", label: "重複" },
  { value: "rejected", label: "対象外" },
  { value: "needs_info", label: "情報不足" },
] as const;

const EVENT_LABEL: Record<string, string> = {
  received: "受付", amended: "追記", withdrawn: "取り下げ", triage_result: "仕分け", verdict_changed: "判定の変更",
  appeal: "再審", task_created: "タスク作成", hotfix_started: "hotfix", pr_recorded: "PR 記録", deployed: "反映",
  reward: "報奨", notified: "通知",
};

export function BountyDetailPanel({ reportId, onChanged, onClose }: { reportId: string; onChanged: () => void; onClose: () => void }) {
  const [report, setReport] = useState<BountyReportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<string>("");
  const [severity, setSeverity] = useState<string>("");
  const [selfInflicted, setSelfInflicted] = useState<string>("");
  const [duplicateOf, setDuplicateOf] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");

  const load = async () => {
    try {
      const result = await api.bountyReport(reportId);
      setReport(result.report);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => { setMessage(null); void load(); }, [reportId]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setMessage(`${label}しました。`);
      await load();
      onChanged();
    } catch (e) {
      setMessage(`${label}できませんでした: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <section className="border border-border rounded p-3 text-danger text-sm">{error}</section>;
  if (!report) return <section className="border border-border rounded p-3 text-subtle text-sm">読み込み中…</section>;

  const appealPending = report.appeal.requested_at !== null && report.appeal.decided_at === null;
  const closable = ["fix_pending", "fixing", "fix_submitted"].includes(report.status);
  const judgement = (): BountyJudgementChange => ({
    ...(verdict ? { verdict: verdict as BountyJudgementChange["verdict"] } : {}),
    ...(severity ? { severity: severity === "none" ? null : severity as BountyJudgementChange["severity"] } : {}),
    ...(selfInflicted ? { self_inflicted: selfInflicted === "yes" } : {}),
    ...(verdict === "duplicate" ? { duplicate_of: duplicateOf.trim() || null } : {}),
    reason,
  });

  return (
    <section className="border border-border rounded p-3 space-y-3 text-sm">
      <div className="flex items-start gap-2">
        <div>
          <h2 className="font-semibold">
            <span className="font-mono">{report.id}</span> — {BOUNTY_STATUS_LABEL[report.status] ?? report.status}
          </h2>
          <div className="text-xs text-subtle">
            受付 {formatTime(report.received_at)} ({report.intake_platform}) / 対象 {report.project ?? "未特定"} /
            報告者 {report.reporter} / 受取人 {report.recipient ?? "なし"}
          </div>
        </div>
        <button type="button" className="ml-auto px-2 py-1 rounded border border-border text-xs" onClick={onClose}>閉じる</button>
      </div>

      {message && <div className="text-xs">{message}</div>}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <h3 className="text-xs font-semibold">原文 (運用担当だけに表示)</h3>
          <pre className="whitespace-pre-wrap text-xs bg-muted rounded p-2 max-h-60 overflow-auto">{report.what_happened || "(空)"}</pre>
          <h3 className="text-xs font-semibold">再現手順</h3>
          <pre className="whitespace-pre-wrap text-xs bg-muted rounded p-2 max-h-40 overflow-auto">{report.repro_steps || "(なし)"}</pre>
        </div>
        <div className="space-y-1 text-xs">
          <h3 className="font-semibold">仕分け</h3>
          <div>判定: {report.verdict ?? "未判定"} / 深刻度: {report.severity ?? "—"} / 機微: {report.sensitive ? "はい" : "いいえ"} /
            自己起因: {report.self_inflicted === null ? "—" : report.self_inflicted ? "はい" : "いいえ"} /
            hotfix 可: {report.hotfix_eligible === null ? "—" : report.hotfix_eligible ? "はい" : "いいえ"}</div>
          {report.duplicate_of && <div>重複先: <span className="font-mono">{report.duplicate_of}</span></div>}
          <div>根拠: {report.verdict_reason ?? "—"}</div>
          <div>公開用の題名: {report.public_title ?? "—"}</div>
          <div>公開用の要約: {report.public_summary ?? "—"}</div>
          <div>仕分けの失敗: {report.triage.failures} 回{report.triage.escalated_at ? ` (権限者へ回した: ${formatTime(report.triage.escalated_at)})` : ""}</div>
          <h3 className="font-semibold pt-1">修正と反映</h3>
          <div>Actio タスク: {report.actio_task_ref ?? "—"}{report.actio_task_error ? ` (失敗: ${report.actio_task_error})` : ""}</div>
          <div>hotfix: {report.hotfix.run_id ? `run ${report.hotfix.run_id} (${formatTime(report.hotfix.started_at)})` : "—"}</div>
          <div>修正の PR: {report.fix_pr ? `#${report.fix_pr}` : "—"}</div>
          <div>反映: {formatTime(report.deployed_at)}{report.deploy.code ? ` (${report.deploy.code} @ ${report.deploy.hash?.slice(0, 12)})` : ""}
            {report.deploy.evidence ? ` 手動: ${report.deploy.evidence} (${report.deploy.closed_by})` : ""}</div>
          <div>報奨: {report.reward.state ?? "未依頼"}{report.reward.tokens !== null ? ` ${report.reward.tokens.toLocaleString("en-US")} トークン` : ""}
            {report.reward.note ? ` (${report.reward.note})` : ""} — 残高は <Link className="underline" to="/personal-budget">個人の AI 予算</Link></div>
          {report.appeal.requested_at !== null && (
            <div>再審: {formatTime(report.appeal.requested_at)} 「{report.appeal.reason}」 {report.appeal.decided_at ? `決定済み ${formatTime(report.appeal.decided_at)}` : "決定待ち"}</div>
          )}
        </div>
      </div>

      <div className="border-t border-border pt-2 space-y-2">
        <h3 className="text-xs font-semibold">権限者の操作</h3>
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <select className="foundation-form text-xs" value={verdict} onChange={(e) => setVerdict(e.target.value)}>
            <option value="">判定 (変えない)</option>
            {VERDICTS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
          </select>
          {verdict === "duplicate" && (
            <input className="foundation-form text-xs w-40" placeholder="重複先の報告 id" value={duplicateOf} onChange={(e) => setDuplicateOf(e.target.value)} />
          )}
          <select className="foundation-form text-xs" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">深刻度 (変えない)</option>
            {["s1", "s2", "s3", "s4"].map((s) => <option key={s} value={s}>{s}</option>)}
            <option value="none">未設定へ</option>
          </select>
          <select className="foundation-form text-xs" value={selfInflicted} onChange={(e) => setSelfInflicted(e.target.value)}>
            <option value="">自己起因 (変えない)</option>
            <option value="yes">自己起因</option>
            <option value="no">自己起因でない</option>
          </select>
          <input className="foundation-form text-xs flex-1 min-w-48" placeholder="理由 (必須・履歴に残る)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="px-2 py-1 rounded border border-border disabled:opacity-50" disabled={busy || !reason.trim()}
            onClick={() => void run("判定を変更", () => api.bountyChangeJudgement(report.id, judgement()))}>判定を変更</button>
        </div>
        {appealPending && (
          <div className="flex flex-wrap gap-2 text-xs">
            <button type="button" className="px-2 py-1 rounded border border-border disabled:opacity-50" disabled={busy || !reason.trim()}
              onClick={() => void run("再審を認めて判定を変更", () => api.bountyDecideAppeal(report.id, {
                uphold: true,
                ...(verdict && verdict !== "needs_info" ? { verdict: verdict as "accepted" | "duplicate" | "rejected" } : {}),
                ...(verdict === "duplicate" ? { duplicate_of: duplicateOf.trim() || null } : {}),
                reason,
              }))}>再審を認める (上の判定へ)</button>
            <button type="button" className="px-2 py-1 rounded border border-border disabled:opacity-50" disabled={busy || !reason.trim()}
              onClick={() => void run("再審を退け", () => api.bountyDecideAppeal(report.id, { uphold: false, reason }))}>再審を退ける</button>
          </div>
        )}
        {report.status === "accepted" && (
          <button type="button" className="px-2 py-1 rounded border border-border text-xs disabled:opacity-50" disabled={busy}
            onClick={() => void run("タスク作成を再試行", () => api.bountyRetryTask(report.id))}>Actio タスクの作成を再試行</button>
        )}
        {closable && (
          <div className="flex flex-wrap gap-2 text-xs">
            <input className="foundation-form text-xs flex-1 min-w-48" placeholder="閉じる根拠 (反映を確認した事実)" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
            <button type="button" className="px-2 py-1 rounded border border-border disabled:opacity-50" disabled={busy || !evidence.trim()}
              onClick={() => void run("手動クローズ", () => api.bountyClose(report.id, evidence))}>反映済みとして閉じる</button>
          </div>
        )}
      </div>

      <div className="border-t border-border pt-2">
        <h3 className="text-xs font-semibold">履歴</h3>
        <ul className="text-xs space-y-0.5 max-h-60 overflow-auto">
          {report.events.map((event) => (
            <li key={event.id}>
              {formatTime(event.created_at)} {EVENT_LABEL[event.kind] ?? event.kind}
              {event.from_value || event.to_value ? `: ${event.from_value ?? ""} → ${event.to_value ?? ""}` : ""}
              <span className="text-subtle"> ({event.actor_kind}{event.actor_id ? ` ${event.actor_id}` : ""})</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
