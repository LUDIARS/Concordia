/**
 * /teams — チーム一覧 (メトリクスカード) + 詳細タブ (spec/feature/teams.md §4.1)。
 * 一覧はカードに 目標数 / 進行中 case / active セッション / 今日のコスト を出し、
 * 詳細は 目標 kanban / セッション / コスト / ルールエディタ / 設定 の 5 タブ。
 * チーム一覧の正本 fetch は TeamFilterProvider と共有する。
 */

import { useState } from "react";
import type { Team } from "../api.js";
import { useTeamFilter } from "../lib/TeamFilterContext.js";
import { fmtTokensShort } from "./teams/model.js";
import { TeamKanban } from "./teams/TeamKanban.js";
import { TeamSessions } from "./teams/TeamSessions.js";
import { TeamCost } from "./teams/TeamCost.js";
import { TeamRulesEditor } from "./teams/TeamRulesEditor.js";
import { TeamSettingsForm } from "./teams/TeamSettingsForm.js";

type TabKey = "goals" | "sessions" | "cost" | "rules" | "settings";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "goals", label: "目標" },
  { key: "sessions", label: "セッション" },
  { key: "cost", label: "コスト" },
  { key: "rules", label: "ルール" },
  { key: "settings", label: "設定" },
];

export function Teams() {
  const { teams, teamsLoaded, teamsError, reloadTeams } = useTeamFilter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("goals");
  const selected = teams.find((team) => team.id === selectedId) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <section>
        <h1 className="mb-3 text-xl font-semibold">Teams</h1>
        {!teamsLoaded && <div className="text-subtle text-sm">loading…</div>}
        {teamsError && <div className="text-danger text-sm">load error: {teamsError.message}</div>}
        {teamsLoaded && !teamsError && teams.length === 0 && (
          <div className="text-subtle text-sm">
            チームはまだありません (POST /v1/teams か /co-team-create で作成)。
          </div>
        )}
        {teams.map((team) => (
          <TeamCard
            key={team.id}
            team={team}
            selected={team.id === selectedId}
            onSelect={() => { setSelectedId(team.id); setTab("goals"); }}
          />
        ))}
      </section>

      <section>
        {!selected && teams.length > 0 && (
          <div className="text-subtle text-sm py-8">チームを選択すると詳細タブが表示されます。</div>
        )}
        {selected && (
          <>
            <header className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold">{selected.name}</h2>
              <span className="text-xs text-subtle">{selected.slug} · {selected.repos.length} repositories</span>
            </header>
            <nav className="mt-3 flex gap-1 border-b border-border">
              {TABS.map((entry) => (
                <button
                  key={entry.key}
                  onClick={() => setTab(entry.key)}
                  className={
                    "px-3 py-1.5 text-sm rounded-t border border-b-0 " +
                    (tab === entry.key
                      ? "border-border bg-surface font-medium"
                      : "border-transparent text-subtle hover:text-text")
                  }
                >
                  {entry.label}
                </button>
              ))}
            </nav>
            <div className="mt-4">
              {tab === "goals" && <TeamKanban teamId={selected.id} />}
              {tab === "sessions" && <TeamSessions teamId={selected.id} />}
              {tab === "cost" && <TeamCost teamId={selected.id} metrics={selected.metrics} />}
              {tab === "rules" && <TeamRulesEditor team={selected} onSaved={reloadTeams} />}
              {tab === "settings" && <TeamSettingsForm team={selected} onSaved={reloadTeams} />}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function TeamCard({ team, selected, onSelect }: { team: Team; selected: boolean; onSelect: () => void }) {
  const metrics = team.metrics;
  return (
    <button
      className={
        "mb-2 block w-full rounded border p-3 text-left hover:bg-muted " +
        (selected ? "border-accent" : "border-border")
      }
      onClick={onSelect}
    >
      <strong>{team.name}</strong>
      <div className="text-xs text-subtle">{team.repos.length} repositories</div>
      {metrics && (
        <div className="mt-2 grid grid-cols-4 gap-1 text-center">
          <Metric label="目標" value={String(metrics.goal_count)} />
          <Metric label="進行中" value={String(metrics.active_case_count)} />
          <Metric label="稼働" value={String(metrics.active_session_count)} />
          <Metric label="今日💰" value={fmtTokensShort(metrics.today_cost_tokens)} />
        </div>
      )}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-muted/40 px-1 py-0.5">
      <div className="text-[10px] text-subtle">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}
