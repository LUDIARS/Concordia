/**
 * 「Muse 指令」: 外部エージェント (Muse / dots) へ出した指令と、 その受領・回答の一覧 (表示だけ)
 * (spec/feature/agent-instructions-bridge.md — Web の画面)。 2026-11-23 neco 指示「Museへの指令を見れる場所」。
 * 行を開くと本文・params・回答の詳細を出す。 指令の登録は POST /v1/instructions (この画面には置かない)。
 *
 * @implements spec/feature/agent-instructions-bridge.md — Web の「Muse 指令」
 */

import { Fragment, useEffect, useState } from "react";
import {
  fetchInstructionHistory,
  INSTRUCTION_AGENT_OPTIONS,
  INSTRUCTION_STATUS_OPTIONS,
  type InstructionRecord,
} from "./muse-instructions/history-api.js";

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  pending: { label: "配信待ち", className: "text-subtle" },
  acked: { label: "受領済み", className: "text-warn" },
  done: { label: "完了", className: "text-ok" },
  failed: { label: "失敗", className: "text-danger" },
};
const REFRESH_MS = 15_000;

function json(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function Detail({ record }: { record: InstructionRecord }) {
  return (
    <div className="space-y-2 text-xs">
      <div>
        <div className="text-subtle">本文</div>
        <pre className="whitespace-pre-wrap break-words">{record.body}</pre>
      </div>
      <div>
        <div className="text-subtle">params</div>
        <pre className="whitespace-pre-wrap break-words font-mono">{json(record.params)}</pre>
      </div>
      <div>
        <div className="text-subtle">回答の要約</div>
        <pre className="whitespace-pre-wrap break-words">{record.resultSummary ?? "(まだありません)"}</pre>
      </div>
      {record.resultDetail !== null && (
        <div>
          <div className="text-subtle">回答の詳細</div>
          <pre className="whitespace-pre-wrap break-words font-mono">{json(record.resultDetail)}</pre>
        </div>
      )}
    </div>
  );
}

export function MuseInstructions() {
  const [agent, setAgent] = useState("");
  const [status, setStatus] = useState("");
  const [records, setRecords] = useState<InstructionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      fetchInstructionHistory({ agent, status }, controller.signal)
        .then((items) => { setRecords(items); setError(null); })
        .catch((e) => { if (!controller.signal.aborted) setError((e as Error).message); });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [agent, status]);

  return (
    <div className="max-w-6xl space-y-4">
      <header>
        <h1 className="font-semibold">Muse 指令</h1>
        <p className="text-subtle text-sm mt-1">
          外部エージェント (Muse / dots) へ出した指令と、受領・回答の記録です (新しい順、最大 50 件)。
          Discord の「muse-指令」チャンネルにも同じ出来事が流れます。
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1">
          宛先
          <select aria-label="宛先" value={agent} onChange={(e) => setAgent(e.target.value)}
            className="border border-border rounded bg-surface px-2 py-1">
            <option value="">すべて</option>
            {INSTRUCTION_AGENT_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          状態
          <select aria-label="状態" value={status} onChange={(e) => setStatus(e.target.value)}
            className="border border-border rounded bg-surface px-2 py-1">
            <option value="">すべて</option>
            {INSTRUCTION_STATUS_OPTIONS.map((value) => <option key={value} value={value}>{STATUS_LABEL[value]?.label ?? value}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="text-danger text-sm">error: {error}</div>}
      {!records && !error && <div className="text-subtle text-sm">loading…</div>}
      {records && records.length === 0 && <div className="text-subtle text-sm">指令はまだありません。</div>}

      {records && records.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-subtle text-xs border-b border-border">
                <th className="py-1 pr-2">宛先</th>
                <th className="py-1 pr-2">id</th>
                <th className="py-1 pr-2">種類</th>
                <th className="py-1 pr-2">題</th>
                <th className="py-1 pr-2">状態</th>
                <th className="py-1 pr-2">作成</th>
                <th className="py-1 pr-2">受領</th>
                <th className="py-1 pr-2">完了</th>
                <th className="py-1">回答の要約</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => {
                const label = STATUS_LABEL[record.status] ?? { label: record.status, className: "" };
                const expanded = open === record.id;
                return (
                  <Fragment key={record.id}>
                    <tr className="border-b border-border cursor-pointer hover:bg-surface align-top"
                      onClick={() => setOpen(expanded ? null : record.id)} aria-expanded={expanded}>
                      <td className="py-1 pr-2">{record.agent}</td>
                      <td className="py-1 pr-2 font-mono text-xs">{record.id}</td>
                      <td className="py-1 pr-2">{record.type}</td>
                      <td className="py-1 pr-2">{record.title}</td>
                      <td className={`py-1 pr-2 whitespace-nowrap ${label.className}`}>{label.label}</td>
                      <td className="py-1 pr-2 whitespace-nowrap text-xs">{record.createdAt}</td>
                      <td className="py-1 pr-2 whitespace-nowrap text-xs">{record.ackedAt ?? "—"}</td>
                      <td className="py-1 pr-2 whitespace-nowrap text-xs">{record.finishedAt ?? "—"}</td>
                      <td className="py-1">{record.resultSummary ?? "—"}</td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-border">
                        <td colSpan={9} className="py-2 px-2 bg-surface"><Detail record={record} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
