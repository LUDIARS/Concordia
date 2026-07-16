import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtTs, api, statusBadge, type ModelCatalogItem, type SessionRow } from "../../api.js";
import { RuntimeOptionsBuilder } from "../../components/RuntimeOptionsBuilder.js";
import { type RunRow, stringArg, firstLine } from "./model.js";

export function OutsourcedRunCard({ run: r }: { run: RunRow }) {
  const target = runTarget(r);
  const linkedSessions = r.sessions ?? [];
  return (
    <article className="border border-border rounded bg-surface p-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-xs px-1.5 py-0.5 rounded bg-bg">{r.call_name}</code>
            <code className="text-xs px-1.5 py-0.5 rounded bg-bg">{r.status}</code>
            <span className="text-xs text-subtle">{fmtDelegationTs(r.created_at)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
            <span>model <code>{r.effective_model ?? "-"}</code></span>
            <span>effort <code>{r.effort_level ?? "-"}</code></span>
            <span>fast <code>{r.fast_mode === 1 ? "ON" : "OFF"}</code></span>
            <span>作業ブランチ <code>{formatWorkingBranch(r.spawn_branch)}</code></span>
          </div>
          <div className="text-sm break-words">{runSummary(r)}</div>
          {target && <div className="text-xs text-subtle break-all">{target}</div>}
          {r.spawn_cwd && <div className="text-xs text-subtle break-all">cwd {r.spawn_cwd}</div>}
          {r.spawn_worktree_path && (
            <div className="text-xs text-subtle break-all">
              worktree {r.spawn_worktree_path}{r.spawn_worktree_created === 1 ? " (created)" : ""}
            </div>
          )}
          {r.error && <div className="text-xs text-red-400 break-words">{r.error}</div>}
        </div>
        <div className="text-xs text-subtle lg:text-right shrink-0">
          <div>pid {r.spawn_pid ?? "-"}</div>
          <div>{r.triggered_by ?? "-"}</div>
        </div>
      </div>
      <div className="mt-2 text-xs font-mono text-subtle break-all">{r.prompt_file_path}</div>
      {linkedSessions.length > 0 ? (
        <div className="mt-3 border-t border-border divide-y divide-border">
          {linkedSessions.map((s) => (
            <div key={s.id} className="py-2 grid gap-1 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/sessions/${encodeURIComponent(s.id)}`}
                    className="font-mono text-xs text-accent hover:underline break-all"
                  >
                    {s.id}
                  </Link>
                  <span className={`px-1.5 py-0.5 rounded text-xs ${statusBadge(s.status)}`}>{s.status}</span>
                  <span className="text-xs text-subtle">{s.provider}</span>
                  <span className="text-xs text-subtle">{formatDuration(s)}</span>
                </div>
                <div className="text-xs text-subtle break-all">{s.repo_path}</div>
                {s.current_task && <div className="text-xs break-words mt-1">{s.current_task}</div>}
              </div>
              <div className="text-xs text-subtle md:text-right">
                <div>{s.branch ?? "-"}</div>
                <div>{fmtDelegationTs(s.started_at)}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 border-t border-border pt-2 text-xs text-subtle">紐付いた Cc session はありません</div>
      )}
    </article>
  );
}

export function runSummary(r: RunRow): string {
  return (
    firstLine(stringArg(r.args, "context_extra")) ??
    firstLine(stringArg(r.args, "task")) ??
    stringArg(r.args, "design_path") ??
    r.call_name
  );
}

function runTarget(r: RunRow): string | null {
  return stringArg(r.args, "target_repo") ?? stringArg(r.args, "repo_path") ?? stringArg(r.args, "cwd");
}

function formatWorkingBranch(branch: string | null): string {
  if (!branch) return "-";
  const lower = branch.toLowerCase();
  return lower === "main" || lower === "master" ? `root ${branch}` : `non-root ${branch}`;
}

function formatDuration(s: SessionRow): string {
  if (!s.ended_at) return "active";
  const seconds = Math.max(0, s.ended_at - s.started_at);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest}s`;
}

export function fmtDelegationTs(ts: number): string {
  return fmtTs(ts > 10_000_000_000 ? Math.floor(ts / 1000) : ts);
}
