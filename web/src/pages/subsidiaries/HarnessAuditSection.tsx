import { useEffect, useState, useCallback } from "react";
import {
  api,
  fmtTs,
  type HarnessRule,
  type HarnessAuditRow,
  type HarnessAuditDecision,
  type HarnessAuditEvent,
  type SubsidiarySummary,
  type SubsidiaryInput,
  type SubsidiaryDelegation,
  type SubsidiaryLock,
  type SubsidiaryRequest,
  type DelegationTemplateLite,
} from "../../api.js";
import { SubsidiaryProjectSpawnForm } from "../../components/SubsidiaryProjectSpawnForm.js";

// ─── ハーネス監査ログ ────────────────────────────────────────────────

const DECISION_BADGE: Record<HarnessAuditDecision, string> = {
  allow: "bg-green-900 text-green-200",
  warn: "bg-yellow-900 text-yellow-200",
  deny: "bg-red-900 text-red-200",
};
const EVENT_LABEL: Record<HarnessAuditEvent, string> = {
  inject: "供給",
  gate: "判定",
  block: "遮断",
  start_prompt: "着手",
  override: "続行",
};

/** created_at は ms (Date.now())。 fmtTs は秒前提なので使わず直接整形する。 */
function fmtMs(ms: number): string {
  return new Date(ms).toLocaleString("ja-JP", { hour12: false });
}

/**
 * ローカルセッション強制ゲートの監査ログ可視化。 「強制が実際に効いたか」を後から裏取りする経路
 * (GET /v1/harness/audit)。 decision / event で絞り込み、 decision 別サマリも表示する。
 */
export function HarnessAuditSection() {
  const [rows, setRows] = useState<HarnessAuditRow[]>([]);
  const [summary, setSummary] = useState<Array<{ decision: HarnessAuditDecision; count: number }>>([]);
  const [decision, setDecision] = useState<HarnessAuditDecision | "">("");
  const [event, setEvent] = useState<HarnessAuditEvent | "">("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .harnessAudit({ decision: decision || undefined, event: event || undefined, limit: 100 })
      .then((r) => {
        setRows(r.audit);
        setSummary(r.summary);
        setErr(null);
      })
      .catch((e) => setErr(String(e)));
  }, [decision, event]);
  useEffect(load, [load]);

  const summaryMap = Object.fromEntries(summary.map((s) => [s.decision, s.count])) as Record<HarnessAuditDecision, number>;

  return (
    <section>
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-lg font-semibold">ハーネス監査ログ</h2>
        <button className="text-xs underline text-subtle" onClick={load}>
          再読込
        </button>
      </div>
      <p className="text-subtle text-xs mb-3">
        ローカルセッションの操作が強制ゲートをどう通ったかの証跡。 全判定 (allow/deny/warn) を 1 行ずつ記録し、
        「強制が効いたか」を後から裏取りする (決定的述語: main 直 push 遮断 / main 編集警告 / 多リポ警告)。
      </p>
      {err && <div className="text-red-400 text-xs mb-2">{err}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {(["deny", "warn", "allow"] as const).map((d) => (
          <span key={d} className={`text-xs px-2 py-0.5 rounded-full ${DECISION_BADGE[d]}`}>
            {d} {summaryMap[d] ?? 0}
          </span>
        ))}
        <span className="flex-1" />
        <select
          className="foundation-form text-xs"
          value={decision}
          onChange={(e) => setDecision(e.target.value as HarnessAuditDecision | "")}
        >
          <option value="">decision: 全て</option>
          <option value="deny">deny (遮断)</option>
          <option value="warn">warn (警告)</option>
          <option value="allow">allow (許可)</option>
        </select>
        <select
          className="foundation-form text-xs"
          value={event}
          onChange={(e) => setEvent(e.target.value as HarnessAuditEvent | "")}
        >
          <option value="">event: 全て</option>
          <option value="gate">判定 (gate)</option>
          <option value="block">遮断 (block)</option>
          <option value="inject">供給 (inject)</option>
          <option value="override">続行 (override)</option>
          <option value="start_prompt">着手 (start_prompt)</option>
        </select>
      </div>

      {rows.length === 0 ? (
        <div className="text-subtle text-xs border border-border rounded-md p-3">
          記録がありません (ゲート未稼働、 または条件に一致なし)。
        </div>
      ) : (
        <div className="border border-border rounded-md overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-subtle">
              <tr className="border-b border-border">
                <th className="text-left font-medium p-2 whitespace-nowrap">時刻</th>
                <th className="text-left font-medium p-2">event</th>
                <th className="text-left font-medium p-2">decision</th>
                <th className="text-left font-medium p-2">tool / rule</th>
                <th className="text-left font-medium p-2">対象 / 理由</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/50 align-top">
                  <td className="p-2 whitespace-nowrap text-subtle">{fmtMs(r.created_at)}</td>
                  <td className="p-2 whitespace-nowrap">{EVENT_LABEL[r.event] ?? r.event}</td>
                  <td className="p-2">
                    <span className={`px-2 py-0.5 rounded-full whitespace-nowrap ${DECISION_BADGE[r.decision]}`}>
                      {r.decision}
                    </span>
                  </td>
                  <td className="p-2 whitespace-nowrap">
                    <div>{r.tool || "—"}</div>
                    {r.rule && <div className="text-subtle">{r.rule}</div>}
                  </td>
                  <td className="p-2 min-w-0">
                    {r.action && <div className="font-mono break-all text-[11px] text-subtle">{r.action}</div>}
                    {r.reason && <div className="break-words">{r.reason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
