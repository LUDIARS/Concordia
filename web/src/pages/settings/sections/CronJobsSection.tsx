// 内部 cron がどの delegation テンプレを起動するかを WebUI から切り替える。
// Spec: spec/feature/delegation.md §9「初期 seed」。
// 既定値はコード側 (src/scheduler/cron-jobs.ts) のまま。ここでの変更は schema_meta へ
// 永続化され、再起動不要で次回発火から反映される (デプロイなしで切り戻せる)。

import { useEffect, useState } from "react";
import { putJson } from "./common.js";

interface CronJobRow {
  name: string;
  cron: string;
  default_call_name: string;
  call_name: string;
  /** 宛先 ("" = 従来の委託 / dots / muse)。 spec/feature/parttimer-agent-dispatch.md */
  agent: string;
  /** data builder があり外部エージェントへ回せるジョブか。 */
  agent_supported: boolean;
}

const AGENT_OPTIONS = [
  { value: "", label: "Cc の委託 (従来)" },
  { value: "dots", label: "dots へ指令" },
  { value: "muse", label: "Muse へ指令" },
] as const;

interface TemplateOption {
  call_name: string;
  title: string;
}

export function CronJobsSection() {
  const [jobs, setJobs] = useState<CronJobRow[] | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fallbackMinutes, setFallbackMinutes] = useState<string>("");

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const [jobsRes, templatesRes, fallbackRes] = await Promise.all([
        fetch("/v1/admin/cron-jobs").then((r) => r.json()) as Promise<{ jobs: CronJobRow[] }>,
        fetch("/v1/delegation/templates").then((r) => r.json()) as Promise<{ templates: TemplateOption[] }>,
        fetch("/v1/admin/cron-jobs-agent-fallback").then((r) => r.json()) as Promise<{ minutes: number }>,
      ]);
      setJobs(jobsRes.jobs);
      setFallbackMinutes(String(fallbackRes.minutes));
      setTemplates(templatesRes.templates.map((t) => ({ call_name: t.call_name, title: t.title })));
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function apply(job: CronJobRow, callName: string) {
    setBusy(job.name); setError(null);
    try {
      await putJson(`/v1/admin/cron-jobs/${encodeURIComponent(job.name)}`, {
        call_name: callName === job.default_call_name ? null : callName,
      });
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  async function applyAgent(job: CronJobRow, agent: string) {
    setBusy(job.name); setError(null);
    try {
      await putJson(`/v1/admin/cron-jobs/${encodeURIComponent(job.name)}/agent`, { agent });
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  async function applyFallbackMinutes() {
    setBusy("__fallback"); setError(null);
    try {
      await putJson("/v1/admin/cron-jobs-agent-fallback", { minutes: Number(fallbackMinutes) });
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-sm">定期実行 (Cron)</h2>
        <p className="text-subtle text-xs mt-0.5">
          内部 cron が毎回どの delegation テンプレを起動するか。既定はコード側 (cron-jobs.ts)
          の値で、ここでの変更は再起動不要・次回発火から反映される。 選べるのは is_active な
          テンプレのみ (呼び出し時に is_active チェックで弾かれるため)。
        </p>
      </div>

      {!jobs && <div className="text-xs text-subtle">読み込み中...</div>}
      {jobs?.map((job) => (
        <div key={job.name} className="bg-muted/40 border border-border rounded p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium font-mono">{job.name}</span>
            <span className="text-xs text-subtle font-mono">{job.cron} (Asia/Tokyo)</span>
            {job.call_name !== job.default_call_name && (
              <span className="px-2 py-0.5 rounded text-xs border bg-warn/20 border-warn text-warn">
                既定 ({job.default_call_name}) から変更中
              </span>
            )}
            <select
              value={job.call_name}
              disabled={busy === job.name}
              onChange={(e) => apply(job, e.target.value)}
              className="bg-muted border border-border rounded px-2 py-1 text-sm ml-auto min-w-[240px]"
            >
              {!templates.some((t) => t.call_name === job.call_name) && (
                <option value={job.call_name}>{job.call_name} (未取得/非アクティブ)</option>
              )}
              {templates.map((t) => (
                <option key={t.call_name} value={t.call_name}>
                  {t.title} ({t.call_name})
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-subtle">宛先</span>
            <select
              aria-label={`${job.name} の宛先`}
              value={job.agent}
              disabled={busy === job.name}
              onChange={(e) => applyAgent(job, e.target.value)}
              className="bg-muted border border-border rounded px-2 py-1 text-sm min-w-[180px]"
            >
              {AGENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} disabled={option.value !== "" && !job.agent_supported}>
                  {option.label}
                </option>
              ))}
            </select>
            {!job.agent_supported && (
              <span className="text-xs text-subtle">外部エージェント用の材料 (data builder) が無いため委託のみ</span>
            )}
            {job.agent !== "" && (
              <span className="px-2 py-0.5 rounded text-xs border bg-warn/20 border-warn text-warn">
                {job.agent} へ指令 (受け取られなければ {fallbackMinutes || "?"} 分で委託へ戻す)
              </span>
            )}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <label htmlFor="cron-agent-fallback-minutes" className="text-subtle">
          指令が受け取られないとき Cc の委託へ戻すまで (分)
        </label>
        <input
          id="cron-agent-fallback-minutes"
          type="number"
          min={1}
          value={fallbackMinutes}
          onChange={(e) => setFallbackMinutes(e.target.value)}
          className="bg-muted border border-border rounded px-2 py-1 w-24"
        />
        <button
          type="button"
          disabled={busy === "__fallback"}
          onClick={() => void applyFallbackMinutes()}
          className="px-2 py-1 rounded border border-border bg-muted"
        >
          保存
        </button>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}
