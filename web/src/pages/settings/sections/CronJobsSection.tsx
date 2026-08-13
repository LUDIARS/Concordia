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
}

interface TemplateOption {
  call_name: string;
  title: string;
}

export function CronJobsSection() {
  const [jobs, setJobs] = useState<CronJobRow[] | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const [jobsRes, templatesRes] = await Promise.all([
        fetch("/v1/admin/cron-jobs").then((r) => r.json()) as Promise<{ jobs: CronJobRow[] }>,
        fetch("/v1/delegation/templates").then((r) => r.json()) as Promise<{ templates: TemplateOption[] }>,
      ]);
      setJobs(jobsRes.jobs);
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
        </div>
      ))}
      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}
