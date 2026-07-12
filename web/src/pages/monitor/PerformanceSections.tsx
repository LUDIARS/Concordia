import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../../api.js";
import type {
  SessionRow,
  DelegationTemplateLite,
  HostSnapshot,
  SubsidiarySummary,
  DiscordConfigStatus,
  SlackConfigStatus,
  ProjectSufficiency,
} from "../../api.js";
import { useLiveQuery } from "../../hooks/useWsEvent.js";
import { DelegationSpawnForm } from "../../components/DelegationSpawnForm.js";

function fmtBytes(b: number | null | undefined): string {
  if (b == null || !isFinite(b)) return "—";
  if (b < 1024) return `${b} B`;
  const mib = b / 1024 ** 2;
  if (mib < 1024) return `${mib.toFixed(0)} MiB`;
  return `${(b / 1024 ** 3).toFixed(2)} GiB`;
}

export function MachinesSection() {
  const { data } = useLiveQuery(() => api.machinesList(), [
    "session.started",
    "session.ended",
    "session.lost",
  ]);
  if (!data || data.machines.length === 0) return null;
  return (
    <section>
      <h2 className="text-base font-semibold mb-2">
        machines <span className="text-subtle text-xs ml-2">{data.machines.length}</span>
      </h2>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
      >
        {data.machines.map((m) => (
          <div key={m.host} className="bg-surface border border-border rounded p-3">
            <div className="font-mono text-sm">{m.host}</div>
            <div className="mt-2 flex items-center gap-3 text-xs">
              <span className="text-ok">active {m.active}</span>
              {m.lost > 0 && <span className="text-warn">lost {m.lost}</span>}
              <span className="text-subtle">ended {m.ended}</span>
              <span className="ml-auto text-subtle">{fmtTs(m.last_seen_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * PC パフォーマンス概況 — ホストのメモリ/CPU + 上位プロセス + WSL/docker +
 * セッション別メモリ (並び替え可)。 host_metrics の最新スナップショットを 10 秒 poll。
 */
export function PerformanceSection() {
  const [snap, setSnap] = useState<HostSnapshot | null | undefined>(undefined);
  const [sortKey, setSortKey] = useState<"rss" | "label">("rss");

  useEffect(() => {
    let stopped = false;
    const tick = () =>
      api.metrics()
        .then((r) => { if (!stopped) setSnap(r.snapshot); })
        .catch(() => { if (!stopped) setSnap(null); });
    void tick();
    const id = setInterval(tick, 10000);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  if (snap === undefined) return null; // 初回ロード中
  if (snap === null) {
    return (
      <section>
        <h2 className="text-base font-semibold mb-2">PC パフォーマンス</h2>
        <div className="text-subtle text-sm">メトリクス未取得 (Concordia 再起動で有効化、 または無効設定)。</div>
      </section>
    );
  }

  const memPct = snap.host.totalMem > 0 ? Math.round((snap.host.usedMem / snap.host.totalMem) * 100) : 0;
  const sessions = [...snap.sessions].sort((a, b) =>
    sortKey === "rss" ? b.rss - a.rss : a.label.localeCompare(b.label),
  );

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">
        PC パフォーマンス
        <span className="text-subtle text-xs ml-2">{fmtTs(Math.floor(snap.sampled_at / 1000))}</span>
      </h2>

      {/* host メモリ / CPU */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
        <div className="bg-surface border border-border rounded p-3">
          <div className="text-xs text-subtle">メモリ</div>
          <div className="text-lg font-semibold">{fmtBytes(snap.host.usedMem)} <span className="text-subtle text-sm">/ {fmtBytes(snap.host.totalMem)} ({memPct}%)</span></div>
          <div className="mt-1 h-1.5 bg-muted rounded overflow-hidden">
            <div className={`h-full ${memPct >= 85 ? "bg-danger" : memPct >= 70 ? "bg-warn" : "bg-accent"}`} style={{ width: `${memPct}%` }} />
          </div>
        </div>
        <div className="bg-surface border border-border rounded p-3">
          <div className="text-xs text-subtle">CPU ({snap.host.cpuCount} コア)</div>
          <div className="text-lg font-semibold">{snap.host.loadPct == null ? "—" : `${snap.host.loadPct}%`}</div>
        </div>
      </div>

      {/* セッション別メモリ (並び替え可) */}
      {sessions.length > 0 && (
        <div className="bg-surface border border-border rounded p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-semibold">セッション別メモリ</span>
            <span className="text-subtle text-xs">{sessions.length}</span>
            <div className="ml-auto flex gap-1 text-xs">
              <button onClick={() => setSortKey("rss")} className={`px-2 py-0.5 rounded ${sortKey === "rss" ? "bg-accent text-white" : "bg-muted"}`}>RSS 順</button>
              <button onClick={() => setSortKey("label")} className={`px-2 py-0.5 rounded ${sortKey === "label" ? "bg-accent text-white" : "bg-muted"}`}>名前順</button>
            </div>
          </div>
          <div className="space-y-1">
            {sessions.map((s) => (
              <Link key={s.session_id} to={`/sessions/${encodeURIComponent(s.session_id)}`} className="flex items-center gap-2 text-xs hover:bg-muted rounded px-1 py-0.5">
                <span className="font-mono font-semibold w-20 text-right">{fmtBytes(s.rss)}</span>
                <span className={`px-1 rounded ${statusBadge(s.status as SessionRow["status"])}`}>{s.status}</span>
                <span className="truncate flex-1">{s.label}</span>
                <span className="text-subtle">{s.procCount}p · pid {s.pid}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* 上位プロセス + WSL/docker */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
        <div className="bg-surface border border-border rounded p-3">
          <div className="text-sm font-semibold mb-1">上位プロセス</div>
          <div className="space-y-0.5">
            {snap.topProcesses.slice(0, 10).map((p) => (
              <div key={p.name} className="flex items-center gap-2 text-xs">
                <span className="font-mono w-20 text-right">{fmtBytes(p.rss)}</span>
                <span className="truncate flex-1">{p.name}</span>
                <span className="text-subtle">×{p.count}</span>
              </div>
            ))}
          </div>
        </div>
        {(snap.wsl.length > 0 || snap.docker.length > 0) && (
          <div className="bg-surface border border-border rounded p-3">
            {snap.wsl.length > 0 && (
              <>
                <div className="text-sm font-semibold mb-1">WSL</div>
                <div className="space-y-0.5 mb-2">
                  {snap.wsl.map((w) => (
                    <div key={w.key} className="flex items-center gap-2 text-xs">
                      <span className="font-mono w-20 text-right">{fmtBytes(w.rss)}</span>
                      <span className="truncate flex-1">{w.key}</span>
                      <span className="text-subtle">{w.side}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {snap.docker.length > 0 && (
              <>
                <div className="text-sm font-semibold mb-1">docker ({snap.docker.length})</div>
                <div className="space-y-0.5">
                  {snap.docker.slice(0, 8).map((d) => (
                    <div key={d.name} className="flex items-center gap-2 text-xs">
                      <span className="font-mono w-20 text-right">{fmtBytes(d.rss)}</span>
                      <span className="truncate flex-1">{d.name}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
