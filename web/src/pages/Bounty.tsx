// @implements SPEC-BOUNTY-WEBUI
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, type BountyReportSummary, type SubsidiarySummary } from "../api.js";
import { BountyDetailPanel } from "./BountyDetail.js";
import { BountyCocoiruKey } from "./BountySettings.js";

// バグバウンティ (spec/feature/bug-bounty.md §8.2)。 運用担当の管理面: 報告の一覧・詳細・履歴を見て、
// 判定の変更・再審の決定・タスク作成の再試行・手動クローズを行う。 一覧は原文を持たず、詳細を開いたときにだけ取る。
// 画面は状態を直接書かず、Cc の use case (API) を呼ぶ。 残高は「個人の AI 予算」ページが持つ。

const PAGE_SIZE = 50;
const ALL = "";

export const BOUNTY_STATUS_LABEL: Record<string, string> = {
  received: "受付 (仕分け待ち)",
  needs_info: "情報不足",
  rejected: "対象外",
  duplicate: "重複",
  accepted: "採用 (タスク未作成)",
  fix_pending: "修正待ち",
  fixing: "hotfix 中",
  fix_submitted: "PR 提出済み",
  deployed: "反映済み",
  withdrawn: "取り下げ",
};

export const formatTime = (ms: number | null): string => (ms ? new Date(ms).toLocaleString("ja-JP") : "—");

export function Bounty() {
  const [status, setStatus] = useState(ALL);
  const [project, setProject] = useState("");
  const [company, setCompany] = useState(ALL);
  const [offset, setOffset] = useState(0);
  const [reports, setReports] = useState<BountyReportSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [hotfixLimit, setHotfixLimit] = useState<number | null>(null);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiarySummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.subsidiariesList().then((r) => setSubsidiaries(r.subsidiaries)).catch(() => setSubsidiaries([]));
  }, []);

  const refresh = async () => {
    try {
      const page = await api.bountyReports({ status, project: project.trim(), company, limit: PAGE_SIZE, offset });
      setReports(page.reports);
      setTotal(page.total);
      setHotfixLimit(page.hotfix_daily_limit);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => { void refresh(); }, [status, company, offset]);

  return (
    <div className="space-y-4 max-w-6xl">
      <header>
        <h1 className="text-lg font-semibold">バグバウンティ</h1>
        <p className="text-subtle text-sm mt-1">
          受け付けたバグ報告の一覧と詳細。AI の仕分け結果を見て、判定の変更・再審の決定・Actio タスク作成の再試行・
          手動クローズを行えます。報奨の残高と台帳は <Link className="underline" to="/personal-budget">個人の AI 予算</Link> にあります。
          hotfix の 1 日の上限 (プロジェクトごと): {hotfixLimit ?? "—"} 件 (<Link className="underline" to="/settings">設定</Link> の
          「バグ報告の hotfix の 1 日の上限」で変えられます)。
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">状態</span>
          <select className="foundation-form text-sm" value={status} onChange={(e) => { setOffset(0); setStatus(e.target.value); }}>
            <option value={ALL}>すべて</option>
            {Object.entries(BOUNTY_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">プロジェクト (コード)</span>
          <input className="foundation-form text-sm w-28" value={project} onChange={(e) => setProject(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { setOffset(0); void refresh(); } }} placeholder="例: Cc" />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">会社</span>
          <select className="foundation-form text-sm" value={company} onChange={(e) => { setOffset(0); setCompany(e.target.value); }}>
            <option value={ALL}>すべて</option>
            <option value="hq">本社</option>
            {subsidiaries.filter((s) => s.mode === "subsidiary").map((s) => (
              <option key={s.id} value={s.id}>{s.display_name || s.name}</option>
            ))}
          </select>
        </label>
        <button type="button" className="px-2 py-1 rounded border border-border text-xs" onClick={() => { setOffset(0); void refresh(); }}>
          絞り込む
        </button>
        <span className="text-xs text-subtle ml-auto">
          {total === 0 ? "0 件" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} / ${total} 件`}
        </span>
        <button type="button" className="px-2 py-1 rounded border border-border text-xs disabled:opacity-50"
          disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>前へ</button>
        <button type="button" className="px-2 py-1 rounded border border-border text-xs disabled:opacity-50"
          disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>次へ</button>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}
      {reports.length === 0 && !error && <div className="text-subtle text-sm">該当する報告はありません。</div>}

      {reports.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-subtle border-b border-border">
                <th className="py-1 pr-2">報告</th>
                <th className="py-1 pr-2">状態</th>
                <th className="py-1 pr-2">プロジェクト</th>
                <th className="py-1 pr-2">深刻度</th>
                <th className="py-1 pr-2">報告者 / 受取人</th>
                <th className="py-1 pr-2">Actio タスク</th>
                <th className="py-1 pr-2">修正の PR</th>
                <th className="py-1 pr-2">反映</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id}
                  className={`border-b border-border cursor-pointer hover:bg-muted ${selected === report.id ? "bg-muted" : ""}`}
                  onClick={() => setSelected(report.id)}>
                  <td className="py-1.5 pr-2">
                    <div className="font-mono">{report.id}</div>
                    <div className="text-subtle">{report.public_title ?? "(未仕分け)"}</div>
                    {report.needs_attention && <div className="text-warn">要対応: {report.needs_attention}</div>}
                  </td>
                  <td className="py-1.5 pr-2">{BOUNTY_STATUS_LABEL[report.status] ?? report.status}</td>
                  <td className="py-1.5 pr-2">{report.project ?? "未特定"}{report.company ? ` @${report.company}` : ""}</td>
                  <td className="py-1.5 pr-2">{report.severity ?? "—"}</td>
                  <td className="py-1.5 pr-2">
                    <div>{report.reporter}</div>
                    <div className="text-subtle">{report.recipient ?? "受取人なし"}</div>
                  </td>
                  <td className="py-1.5 pr-2">
                    {report.actio_task_ref ?? (report.actio_task_error ? <span className="text-danger">失敗</span> : "—")}
                  </td>
                  <td className="py-1.5 pr-2">{report.fix_pr ? `#${report.fix_pr}` : "—"}</td>
                  <td className="py-1.5 pr-2">{formatTime(report.deployed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <BountyDetailPanel reportId={selected} onChanged={() => void refresh()} onClose={() => setSelected(null)} />
      )}

      <BountyCocoiruKey />
    </div>
  );
}
