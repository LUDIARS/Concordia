import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, type DirectorCaseSummary } from "../api.js";
import {
  CASE_COLUMNS,
  blockedReasonLabel,
  blockedSteps,
  caseProgress,
  groupCasesByColumn,
} from "./teams/model.js";

// Director — 目標 (case) の進み方をチーム横断で 1 画面にまとめる。
//
// チーム別の kanban は Teams の詳細タブにあるが、 **チームを選ばないと見られず**、
// 「ブロック」列も case を出すだけで **どの工程が何で止まっているかはカードを開かないと
// 分からない**。 受け入れ基準は「どの工程で何に blocked か が 1 画面で分かる」なので、
// ここでは止まっている工程を理由ごと先頭に並べる。
//
// 読み取り専用。 工程を動かすのは engine (巡回) と API で、 この画面ではしない。
//
// @implements spec/feature/director-goal-flow.md 受け入れ基準 4

const STEP_GLYPH: Record<DirectorCaseSummary["steps"][number]["status"], string> = {
  completed: "✅",
  active: "🔵",
  blocked: "⛔",
  cancelled: "✖",
  pending: "⚪",
};

function BlockedList({ cases }: { cases: readonly DirectorCaseSummary[] }) {
  const blocked = blockedSteps(cases);
  if (blocked.length === 0) {
    return <div className="text-sm text-subtle">止まっている工程はありません。</div>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {blocked.map((entry) => (
        <li key={entry.step.id} className="rounded border border-border bg-surface px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-medium">{entry.caseTitle}</span>
            <span className="text-xs text-subtle">{entry.project}</span>
          </div>
          <div className="text-sm">
            ⛔ {entry.step.kind}: {entry.step.title}
          </div>
          {/* 内部 handoff note の生文は資格情報やローカルパスを含み得るため表示しない。 */}
          <div className="text-xs text-subtle break-words">
            {blockedReasonLabel(entry.step.blocked_reason)}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Director() {
  const [cases, setCases] = useState<DirectorCaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCases((await api.directorCases({})).cases);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
    // 工程は engine が動かすので、 この画面は自分では変化を知れない。
    const timer = setInterval(() => { void load(); }, 60_000);
    return () => { clearInterval(timer); };
  }, [load]);

  if (error) return <div className="text-sm text-warn">読み込みに失敗しました: {error}</div>;
  if (cases === null) return <div className="text-sm text-subtle">読み込み中…</div>;

  const grouped = groupCasesByColumn(cases);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Director</h1>
        <span className="text-sm text-subtle">目標 {cases.length} 件</span>
        <Link className="ml-auto text-xs text-accent hover:underline" to="/teams">
          チーム別に見る
        </Link>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">止まっている工程</h2>
        <BlockedList cases={cases} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">目標の進み方</h2>
        {cases.length === 0 ? (
          <div className="text-sm text-subtle">目標 (case) はまだありません。</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {CASE_COLUMNS.map((column) => (
              <div key={column.key} className="space-y-2">
                <h3 className="text-xs font-semibold text-subtle">
                  {column.label} <span className="font-normal">({grouped[column.key].length})</span>
                </h3>
                {grouped[column.key].map((entry) => (
                  <article key={entry.case.id} className="rounded border border-border bg-surface p-2 space-y-1">
                    <div className="text-sm font-medium" title={entry.case.goal}>{entry.case.title}</div>
                    <div className="text-[11px] text-subtle">
                      {entry.case.project} · step {caseProgress(entry.steps)}
                    </div>
                    <ul className="text-[11px] text-subtle space-y-0.5">
                      {entry.steps.map((step) => (
                        <li
                          key={step.id}
                          className="truncate"
                          title={step.status === "blocked" ? blockedReasonLabel(step.blocked_reason) : step.title}
                        >
                          <span aria-label={step.status}>{STEP_GLYPH[step.status]}</span> {step.kind}: {step.title}
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
