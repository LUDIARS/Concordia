/**
 * 指令の一覧 (GET /v1/instructions/history、 loopback のみ) を読む (spec/feature/agent-instructions-bridge.md — 一覧の口)。
 * 公開ホスト経由で開いた画面からは 403 になるので、 その旨をエラー文で返す。
 *
 * @implements spec/feature/agent-instructions-bridge.md — Web の「Muse 指令」
 */

export const INSTRUCTION_AGENT_OPTIONS = ["muse", "dots"] as const;
export const INSTRUCTION_STATUS_OPTIONS = ["pending", "acked", "done", "failed"] as const;

export interface InstructionRecord {
  id: string;
  agent: string;
  type: string;
  title: string;
  status: string;
  createdAt: string;
  ackedAt: string | null;
  finishedAt: string | null;
  resultSummary: string | null;
  body: string;
  params: unknown;
  resultDetail: unknown;
}

export interface HistoryFilter {
  agent: string;
  status: string;
  limit?: number;
}

export function historyUrl(filter: HistoryFilter): string {
  const query = new URLSearchParams();
  if (filter.agent) query.set("agent", filter.agent);
  if (filter.status) query.set("status", filter.status);
  query.set("limit", String(filter.limit ?? 50));
  return `/v1/instructions/history?${query.toString()}`;
}

export async function fetchInstructionHistory(filter: HistoryFilter, signal?: AbortSignal): Promise<InstructionRecord[]> {
  const response = await fetch(historyUrl(filter), { signal });
  const body = await response.json().catch(() => null) as
    | { data?: { instructions?: InstructionRecord[] }; error?: { code?: string; message?: string } }
    | null;
  if (!response.ok) {
    if (response.status === 403) throw new Error("この一覧は Concordia の自宅側 (loopback) からだけ開けます");
    throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  }
  return body?.data?.instructions ?? [];
}
