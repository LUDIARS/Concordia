import { useEffect, useRef, useState } from "react";
import { controlApi, type AiWeeklyQuota } from "./controlApi.js";

const resetFormat = new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "short" });

/** @implements CC-COST-QUOTA-INV-01 */
export function AiQuotaOverlay({ onClose }: { onClose: () => void }) {
  const [providers, setProviders] = useState<AiWeeklyQuota[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        event.preventDefault();
        if (document.activeElement === closeButton.current && !refreshButton.current?.disabled) {
          refreshButton.current?.focus();
        } else {
          closeButton.current?.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    void controlApi.latestQuotas(controller.signal)
      .then(({ providers }) => {
        if (!controller.signal.aborted) setProviders(providers);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);

  function refresh() {
    setLoading(true);
    setError(false);
    setRevision((previous) => previous + 1);
  }

  return <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4" onClick={onClose}>
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-quota-title"
      className="ml-auto max-w-xl rounded border border-border bg-surface p-4"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="ai-quota-title" className="font-semibold">AI の週間残量</h2>
        <div className="flex items-center gap-3">
          <button ref={refreshButton} type="button" className="rounded border border-border px-2 py-1 text-sm disabled:opacity-50" onClick={refresh} disabled={loading}>更新</button>
          <button ref={closeButton} type="button" className="px-2 py-1" onClick={onClose} aria-label="AI 残量を閉じる">×</button>
        </div>
      </div>
      {loading && <p role="status" className="mt-2 text-sm text-subtle">取得中…</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">週間残量を取得できませんでした。</p>}
      <ul className="mt-4 space-y-4">
        {providers.map((quota) => <QuotaRow key={quota.key} quota={quota} />)}
      </ul>
    </section>
  </div>;
}

function QuotaRow({ quota }: { quota: AiWeeklyQuota }) {
  const { label, remainWeeklyPct: remaining, plan, resetWeeklyAt } = quota;
  const color = remaining !== null && remaining <= 5 ? "bg-danger"
    : remaining !== null && remaining <= 20 ? "bg-amber-500" : "bg-accent";
  return <li className="space-y-1 text-sm">
    <div className="flex justify-between gap-3">
      <span className="font-medium">{label}</span>
      <span className="tabular-nums">{remaining === null ? "未計測" : `残 ${remaining}%`}</span>
    </div>
    <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-border">
      {remaining !== null && <div className={`h-full ${color}`} style={{ width: `${remaining}%` }} />}
    </div>
    {(plan || resetWeeklyAt !== null) && <p className="flex flex-wrap gap-x-3 text-xs text-subtle">
      {plan && <span>{plan}</span>}
      {resetWeeklyAt !== null && <span>週間リセット {resetFormat.format(resetWeeklyAt * 1000)}</span>}
    </p>}
  </li>;
}
