/**
 * Sidecar 親からの委託起動を絞る (application use case)。
 *
 * /v1/delegation/invoke の入口で呼ぶ。 親が Astra With Sidecar でなければ何もしない。
 * 親なら、パケット検証 → 起動可否 (gate.ts) → 起動入力の組み立てを行う。 親の contract の
 * model / effort / branch は子へ持ち込まない (子は profile の Sol medium、独立 worktree)。
 * 許可・拒否はすべて記録する。
 *
 * @implements spec/feature/astra-with-sidecar.md §モデル選択と委任契約
 */

import type { DelegationRunRow, DelegationTemplateRow } from "../../db/delegation-repo.js";
import type { InvokeInput } from "../contracts.js";
import { decideSidecarInvoke, type SidecarChildRunFacts } from "./gate.js";
import { parseSidecarPacket, renderSidecarPacket, type PacketIssue, type SidecarPacket } from "./packet.js";
import { ASTRA_WITH_SIDECAR_PROFILE, isSidecarParentMetadata } from "./profile.js";
import type { SidecarInvokeEventRow, SidecarRecordsRepo } from "./records-repo.js";

export interface SidecarInvokeGuardPorts {
  resolveChildSpec?: () => import("./profile.js").SidecarModelSpec;
  findSession: (sessionId: string) => { metadata: string | null; branch: string | null } | null;
  findTemplateByCallName: (callName: string) => DelegationTemplateRow | null;
  listRunsByParentSession: (sessionId: string) => DelegationRunRow[];
  records: Pick<SidecarRecordsRepo, "recordInvokeEvent" | "listInvokeEvents">;
  now: () => number;
}

export interface SidecarInvokeRequest {
  call_name: string;
  args: Record<string, unknown>;
  parent_session_id: string | null;
  overrides?: InvokeInput["overrides"];
  triggered_by?: string;
  subsidiary_id?: string | null;
  project?: string | null;
}

export type SidecarInvokeGuardResult =
  | { kind: "not_sidecar" }
  | { kind: "reject"; status: 400 | 409; code: string; detail: string; issues?: PacketIssue[]; blocking_run_ids?: string[] }
  | { kind: "allow"; input: InvokeInput; requestKey: string; packet: SidecarPacket; attempt: number };

export function guardSidecarInvoke(ports: SidecarInvokeGuardPorts, request: SidecarInvokeRequest): SidecarInvokeGuardResult {
  const parentId = request.parent_session_id;
  if (!parentId) return { kind: "not_sidecar" };
  const parent = ports.findSession(parentId);
  if (!parent || !isSidecarParentMetadata(parent.metadata)) return { kind: "not_sidecar" };

  const reject = (status: 400 | 409, code: string, detail: string, extra: Partial<Extract<SidecarInvokeGuardResult, { kind: "reject" }>> = {}) => {
    ports.records.recordInvokeEvent({
      parentSessionId: parentId,
      requestKey: null,
      runId: null,
      outcome: "rejected",
      code,
      detail,
      now: ports.now(),
    });
    return { kind: "reject" as const, status, code, detail, ...extra };
  };

  const parsed = parseSidecarPacket(request.args.sidecar_packet);
  if (!parsed.ok) {
    return reject(400, "sidecar_packet_invalid", "args.sidecar_packet is missing or invalid", { issues: parsed.issues });
  }
  const packet = parsed.packet;
  const child = ports.resolveChildSpec?.() ?? ASTRA_WITH_SIDECAR_PROFILE.child;
  const decision = decideSidecarInvoke({
    childSpec: child,
    requestedCallName: request.call_name,
    childTemplate: ports.findTemplateByCallName(request.call_name),
    packet,
    childRuns: childRunFacts(ports.listRunsByParentSession(parentId), ports.records.listInvokeEvents(parentId, 500)),
    parentBranch: parent.branch,
    requestedOverride: request.overrides ?? null,
  });
  if (!decision.allow) {
    const status = decision.code === "sidecar_concurrency_limit" || decision.code === "sidecar_attempt_limit" ? 409 : 400;
    return reject(status, decision.code, decision.detail, decision.blockingRunIds ? { blocking_run_ids: decision.blockingRunIds } : {});
  }

  const input: InvokeInput = {
    call_name: child.call_name,
    args: {
      task: packet.objective,
      target_repo: packet.repo_path,
      context_extra: renderSidecarPacket(packet),
    },
    cwd: packet.repo_path,
    branch: packet.child_branch,
    worktree: true,
    base_ref: packet.base_commit,
    triggered_by: request.triggered_by,
    // 親の契約値ではなく profile の値で固定する (指定外モデルへ黙って切り替えない)。
    overrides: { provider: child.provider, model: child.model, reasoning_effort: child.effort },
    parent_session_id: parentId,
    subsidiary_id: request.subsidiary_id ?? null,
    project: request.project ?? null,
    memory_links: packet.design_refs.filter((ref) => !/^https?:/i.test(ref)).slice(0, 20),
  };
  return { kind: "allow", input, requestKey: decision.requestKey, packet, attempt: decision.attempt };
}

/** 起動結果を記録する。 run が作れなかった場合も残し、再試行の数え漏れを防ぐ。 */
export function recordSidecarLaunch(
  ports: Pick<SidecarInvokeGuardPorts, "records" | "now">,
  input: { parentSessionId: string; requestKey: string; runId: string | null; error: string | null },
): void {
  ports.records.recordInvokeEvent({
    parentSessionId: input.parentSessionId,
    requestKey: input.requestKey,
    runId: input.runId,
    outcome: input.runId ? "allowed" : "launch_failed",
    code: input.error ? "launch_failed" : null,
    detail: input.error,
    now: ports.now(),
  });
}

/** 親の子 run に、許可記録から依頼キーを対応付ける。 */
export function childRunFacts(runs: readonly DelegationRunRow[], events: readonly SidecarInvokeEventRow[]): SidecarChildRunFacts[] {
  const keyByRun = new Map<string, string>();
  for (const event of events) {
    if (event.run_id && event.request_key) keyByRun.set(event.run_id, event.request_key);
  }
  const facts: SidecarChildRunFacts[] = runs.map((run) => ({
    id: run.id,
    status: run.status,
    request_key: keyByRun.get(run.id) ?? null,
  }));
  // 起動に失敗した試行も回数に含める (run は無いが依頼は出し直している)。
  for (const event of events) {
    if (event.outcome === "launch_failed" && event.request_key) {
      facts.push({ id: `launch-failed:${event.id}`, status: "spawn_failed", request_key: event.request_key });
    }
  }
  return facts;
}
