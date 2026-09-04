/**
 * チーム詳細タブ「目標・case kanban」。 director_cases + steps の read model を
 * 列 (未着手/進行中/ブロック/完了/中止) に分類して表示する (teams.md §4.1)。
 */

import { useEffect, useState } from "react";
import { api, type DirectorCaseSummary } from "../../api.js";
import { CASE_COLUMNS, blockedReasonLabel, caseProgress, groupCasesByColumn } from "./model.js";

export function TeamKanban({ teamId }: { teamId: string }) {
  const [cases, setCases] = useState<DirectorCaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCases(null);
    setError(null);
    void api.directorCases({ teamId })
      .then((result) => { if (!cancelled) setCases(result.cases); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [teamId]);

  if (error) return <div className="text-danger text-sm">load error: {error}</div>;
  if (!cases) return <div className="text-subtle text-sm">loading…</div>;
  if (cases.length === 0) {
    return <div className="text-subtle text-sm">このチームの目標 (case) はまだありません。</div>;
  }

  const grouped = groupCasesByColumn(cases);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {CASE_COLUMNS.map((column) => (
        <section key={column.key} className="space-y-2">
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
                    <StepBadge status={step.status} /> {step.kind}: {step.title}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}

function StepBadge({ status }: { status: DirectorCaseSummary["steps"][number]["status"] }) {
  const glyph = status === "completed" ? "✅"
    : status === "active" ? "🔵"
    : status === "blocked" ? "⛔"
    : status === "cancelled" ? "✖" : "⚪";
  return <span aria-label={status}>{glyph}</span>;
}
