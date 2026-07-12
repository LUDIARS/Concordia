import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../api.js";
import type {
  SessionRow,
  DelegationTemplateLite,
  HostSnapshot,
  SubsidiarySummary,
  DiscordConfigStatus,
  SlackConfigStatus,
  ProjectSufficiency,
} from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";
import { DelegationSpawnForm } from "../components/DelegationSpawnForm.js";
import { OrganizationsSection } from "./monitor/OrganizationsSection.js";
import { MachinesSection, PerformanceSection } from "./monitor/PerformanceSections.js";
import { SessionList } from "./monitor/SessionList.js";

export function Monitor() {
  const { data, error } = useLiveQuery(
    () => api.monitor(),
    [
      "session.started",
      "session.ended",
      "session.lost",
      "session.event",
      "persona.assigned",
      "persona.released",
    ],
  );

  // 各 session の最新 stat (10 分毎の poll 結果). フラットチームの相互状況把握用.
  const stats = useLiveQuery(() => api.statList(), ["stat.collected"]);
  const statByIdx = new Map<string, { latest_ts: number; payload: Record<string, unknown> }>();
  for (const it of stats.data?.items ?? []) {
    statByIdx.set(it.session_id, { latest_ts: it.latest_ts, payload: it.payload });
  }

  if (error) return <div className="text-danger">load error: {error.message}</div>;
  if (!data) return <div className="text-subtle">loading…</div>;

  // 同 repo の active session が複数いるものを「競合」 として抽出
  const conflictRepos = data.repos.filter((r) => r.count >= 2);
  const conflictSessionsByRepo = new Map<string, SessionRow[]>();
  for (const r of conflictRepos) {
    conflictSessionsByRepo.set(
      r.key,
      data.active.filter((s) => (s.repo_origin ?? s.repo_path) === r.key),
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-base font-semibold mb-2">
          repos <span className="text-subtle text-xs ml-2">{data.repos.length}</span>
        </h2>
        <div className="flex flex-wrap gap-2">
          {data.repos.length === 0 && (
            <span className="text-subtle text-sm">no active session</span>
          )}
          {data.repos.map((r) => {
            const conflict = r.count >= 2;
            return (
              <span
                key={r.key}
                className={`px-2 py-1 border rounded text-xs ${
                  conflict
                    ? "bg-warn/10 border-warn text-warn"
                    : "bg-muted border-border"
                }`}
                title={conflict ? "複数 active session が同一 repo で作業中" : undefined}
              >
                {r.key}
                <span className={`ml-2 ${conflict ? "font-bold" : "text-accent"}`}>×{r.count}</span>
              </span>
            );
          })}
        </div>
      </section>

      {conflictRepos.length > 0 && (
        <section>
          <h2 className="text-base font-semibold mb-2">
            ⚠ conflicts <span className="text-subtle text-xs ml-2">{conflictRepos.length}</span>
          </h2>
          <div className="space-y-2">
            {conflictRepos.map((r) => (
              <div
                key={r.key}
                className="bg-warn/5 border border-warn/40 rounded p-3 text-sm"
              >
                <div className="font-mono text-xs text-subtle mb-2">{r.key}</div>
                <div className="flex flex-wrap gap-2">
                  {(conflictSessionsByRepo.get(r.key) ?? []).map((s) => (
                    <Link
                      key={s.id}
                      to={`/sessions/${encodeURIComponent(s.id)}`}
                      className="px-2 py-1 bg-surface border border-border rounded text-xs hover:border-accent"
                    >
                      <span className="text-accent">{s.branch ?? "(no branch)"}</span>
                      <span className="ml-2 text-subtle">
                        {((s.metadata as any)?.role_label ?? "雑用係")} / {s.id.slice(0, 8)}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <OrganizationsSection active={data.active} />
      <MachinesSection />
      <PerformanceSection />

      <SessionList title="lost" rows={data.lost} statByIdx={statByIdx} />
    </div>
  );
}

/** トークン数を人が読みやすい桁 (1,234k / 1,234) に整形する。 */
