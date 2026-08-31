import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type SubsidiarySummary,
  type TaskflowCiStatus,
  type TaskflowOverviewResult,
  type TaskflowTaskStatus,
} from "../api.js";
import { useTeamFilter } from "../lib/TeamFilterContext.js";

const STATUS_LABEL: Record<TaskflowTaskStatus, string> = {
  pending: "未着手",
  delegated: "担当中",
  done: "完了",
  cancelled: "中止",
};

const STATUS_BADGE: Record<TaskflowTaskStatus, string> = {
  pending: "bg-warn/20 text-warn",
  delegated: "bg-accent/20 text-accent",
  done: "bg-ok/20 text-ok",
  cancelled: "bg-subtle/20 text-subtle",
};

const CI_BADGE: Record<TaskflowCiStatus, string> = {
  success: "bg-ok/20 text-ok",
  failure: "bg-danger/20 text-danger",
  pending: "bg-warn/20 text-warn",
  unknown: "bg-subtle/20 text-subtle",
};

export function Taskflow() {
  const { teamId, team } = useTeamFilter();
  const [data, setData] = useState<TaskflowOverviewResult | null>(null);
  const [project, setProject] = useState("");
  const [status, setStatus] = useState<TaskflowTaskStatus | "">("");
  const [organization, setOrganization] = useState("all");
  const [subsidiaries, setSubsidiaries] = useState<SubsidiarySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    try {
      const subsidiaryId = organization.startsWith("subsidiary:")
        ? organization.slice("subsidiary:".length)
        : undefined;
      const [nextData, subsidiaryResult] = await Promise.all([
        api.taskflowOverview({
          teamId: teamId ?? undefined,
          subsidiaryId,
          headOffice: organization === "head-office",
        }),
        api.subsidiariesList(),
      ]);
      if (generation !== requestGenerationRef.current) return;
      setData(nextData);
      setSubsidiaries(subsidiaryResult.subsidiaries);
      setError(null);
    } catch (nextError) {
      if (generation === requestGenerationRef.current) setError(String(nextError));
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false);
    }
  }, [organization, teamId]);

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      clearInterval(timer);
      requestGenerationRef.current += 1;
    };
  }, [load]);

  const projects = useMemo(
    () => [...new Set(data?.tasks.map((task) => task.project) ?? [])].sort(),
    [data],
  );
  const visible = useMemo(
    () => (data?.tasks ?? []).filter((task) =>
      (!project || task.project === project) && (!status || task.status === status),
    ),
    [data, project, status],
  );
  const subsidiaryNames = useMemo(
    () => new Map(subsidiaries.map((subsidiary) => [subsidiary.id, subsidiary.display_name || subsidiary.name])),
    [subsidiaries],
  );

  return (
    <div className="max-w-7xl space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            Taskflow
            {team && <span className="ml-2 text-xs font-normal text-subtle">チーム: {team.name}</span>}
          </h1>
          <p className="text-xs text-subtle">task md を正本に、担当・状態・PR・CI を 1 画面で確認します。</p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto px-2 py-1 rounded border border-border text-subtle hover:text-text text-xs disabled:opacity-50"
        >
          {loading ? "…" : "更新"}
        </button>
      </header>

      {data && (
        <section className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 text-sm">
          <Summary label="全件" value={data.counts.total} />
          <Summary label="未着手" value={data.counts.pending} />
          <Summary label="担当中" value={data.counts.delegated} />
          <Summary label="完了" value={data.counts.done} />
          <Summary label="中止" value={data.counts.cancelled} />
          <Summary label="CI失敗" value={data.counts.ci_failure} danger />
          <Summary label="CI待ち" value={data.counts.ci_pending} />
        </section>
      )}

      <section className="flex flex-wrap gap-2 items-center">
        <select
          className="foundation-form text-sm"
          value={organization}
          onChange={(event) => setOrganization(event.target.value)}
        >
          <option value="all">全社</option>
          <option value="head-office">本社</option>
          {subsidiaries.map((subsidiary) => (
            <option key={subsidiary.id} value={`subsidiary:${subsidiary.id}`}>
              {subsidiary.display_name || subsidiary.name}
            </option>
          ))}
        </select>
        <select className="foundation-form text-sm" value={project} onChange={(event) => setProject(event.target.value)}>
          <option value="">全プロジェクト</option>
          {projects.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select
          className="foundation-form text-sm"
          value={status}
          onChange={(event) => setStatus(event.target.value as TaskflowTaskStatus | "")}
        >
          <option value="">全状態</option>
          {(Object.keys(STATUS_LABEL) as TaskflowTaskStatus[]).map((value) => (
            <option key={value} value={value}>{STATUS_LABEL[value]}</option>
          ))}
        </select>
        <span className="text-xs text-subtle">表示 {visible.length} 件</span>
      </section>

      {error && <div className="text-danger text-sm">load error: {error}</div>}

      <div className="overflow-x-auto border border-border rounded bg-surface">
        <table className="w-full min-w-[1040px] text-sm">
          <thead className="text-xs text-subtle border-b border-border">
            <tr>
              <th className="text-left p-2">Project / Task</th>
              <th className="text-left p-2">組織</th>
              <th className="text-left p-2">担当</th>
              <th className="text-left p-2">状態</th>
              <th className="text-left p-2">Session / Run</th>
              <th className="text-left p-2">PR</th>
              <th className="text-left p-2">CI</th>
              <th className="text-left p-2">種別</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((task) => (
              <tr key={`${task.repo_path}:${task.path}`} className="border-b border-border/50 last:border-0">
                <td className="p-2 max-w-md">
                  <div className="text-xs text-subtle">{task.project}</div>
                  <div className="font-medium truncate" title={task.title}>{task.title}</div>
                  <div className="text-[11px] text-subtle font-mono truncate" title={task.path}>{task.path}</div>
                </td>
                <td className="p-2 text-xs">
                  {task.subsidiary_id
                    ? subsidiaryNames.get(task.subsidiary_id) ?? shortId(task.subsidiary_id)
                    : "本社"}
                </td>
                <td className="p-2">{task.assignee ?? <span className="text-subtle">未割当</span>}</td>
                <td className="p-2">
                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${STATUS_BADGE[task.status]}`}>
                    {STATUS_LABEL[task.status]}
                  </span>
                </td>
                <td className="p-2 text-xs">
                  {task.parent_session_id || task.child_session_id ? (
                    // 委託タスク: 管理者 (親) → 実装担当 (子) の系譜で表示する。
                    <div className="font-mono">
                      {task.parent_session_id ? (
                        <Link className="text-accent" title="管理セッション (委託元)" to={`/sessions/${encodeURIComponent(task.parent_session_id)}`}>
                          {shortId(task.parent_session_id)}
                        </Link>
                      ) : <span className="text-subtle">—</span>}
                      <span className="text-subtle"> → </span>
                      {task.child_session_id ? (
                        <Link className="text-accent" title="実装セッション (委託先)" to={`/sessions/${encodeURIComponent(task.child_session_id)}`}>
                          {shortId(task.child_session_id)}
                        </Link>
                      ) : <span className="text-subtle">未紐付け</span>}
                    </div>
                  ) : task.source_session ? (
                    <Link className="text-accent font-mono" to={`/sessions/${encodeURIComponent(task.source_session)}`}>
                      {shortId(task.source_session)}
                    </Link>
                  ) : <span className="text-subtle">—</span>}
                  {task.delegation_run_id && (
                    <div className="text-subtle font-mono" title={task.delegation_run_id}>
                      run {shortId(task.delegation_run_id)} · {task.delegation_status ?? "unknown"}
                    </div>
                  )}
                </td>
                <td className="p-2 text-xs">
                  {task.pr ? (
                    <a href={task.pr.url ?? "#"} target="_blank" rel="noreferrer" className="text-accent">
                      #{task.pr.number} · {task.pr.state}
                    </a>
                  ) : <span className="text-subtle">—</span>}
                </td>
                <td className="p-2">
                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${CI_BADGE[task.ci_status]}`}>
                    {task.ci_status}
                  </span>
                </td>
                <td className="p-2 text-xs">{task.kind || "—"}</td>
              </tr>
            ))}
            {data && visible.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-subtle">該当する task md はありません。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Summary({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="border border-border rounded bg-surface p-2">
      <div className="text-xs text-subtle">{label}</div>
      <div className={`text-lg font-semibold ${danger && value > 0 ? "text-danger" : ""}`}>{value}</div>
    </div>
  );
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}
