/** Same live child receives later work. Unknown delivery is retained for reconciliation. */
import { randomUUID } from "node:crypto";
import type { DelegationRepo } from "../../db/delegation-repo.js";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import { decideResidentReuse, readResidentMarker, type ResidentChild } from "./lifecycle-policy.js";
import { ResidentSidecarRepo, type ResidentReceipt } from "./lifecycle-repo.js";
import { sidecarRequestKey, type SidecarPacket } from "./packet.js";
import type { InvokeInput } from "../contracts.js";
import { readSubsidiaryId } from "../../shared/subsidiary-id.js";
export interface ResidentSidecarPorts {
  residents: ResidentSidecarRepo; runs: DelegationRepo; sessions: SessionsRepo;
  deliver(sessionId: string, text: string, requestId: string): Promise<"delivered" | "unknown">;
  now(): number;
  prepareRequest?: (input:InvokeInput,runId:string) => Promise<{ok:true;text:string} | {ok:false;error:string}>;
  canStartRequest?: () => boolean;
}
export async function continueResidentSidecar(ports: ResidentSidecarPorts, input: {
  parentId: string; packet: SidecarPacket; organization: string; invocation?:InvokeInput;
}): Promise<ResidentReceipt | null> {
  const key = sidecarRequestKey(input.packet);
  const previous = ports.residents.receipt(input.parentId,key);
  if (previous) return previous;
  const child = ports.residents.findByParent(input.parentId);
  if (!child) return null;
  const session = child.child_session_id ? ports.sessions.findSession(child.child_session_id) : null;
  const marker = readResidentMarker(session?.metadata ?? null);
  const reason = decideResidentReuse(child,{ parentId:input.parentId,repoPath:input.packet.repo_path,
    organization:input.organization,branch:input.packet.child_branch,childActive:session?.status === "active",
    generationMatches: marker?.generation === child.generation && marker.id === child.id });
  if (reason) throw new Error(reason);
  const parent = ports.sessions.findSession(input.parentId);
  if (!parent || parent.status !== "active") throw new Error("resident_parent_not_active");
  const parentBinding = {repoPath:parent.repo_path,origin:parent.repo_origin,branch:parent.branch,
    subsidiary:readSubsidiaryId(parent.metadata),task:parent.current_task,targetProject:parent.target_project};
  const old = child.current_run_id ? ports.runs.findRun(child.current_run_id) : null;
  if (!old || !session) throw new Error("resident_run_unknown");
  if (ports.canStartRequest && !ports.canStartRequest()) throw new Error("resident_capacity_unavailable");
  if (!ports.prepareRequest || !input.invocation) throw new Error("resident_request_validation_unavailable");
  const runId = randomUUID();
  const receipt: ResidentReceipt = { parent_id:input.parentId,request_key:key,child_id:child.id,
    generation:child.generation,run_id:runId,delivery:"prepared" };
  if (!ports.residents.reserve(child,receipt,ports.now())) {
    const existing = ports.residents.receipt(input.parentId,key);
    if (existing) return existing;
    throw new Error("resident_busy");
  }
  let prepared:Awaited<ReturnType<NonNullable<ResidentSidecarPorts["prepareRequest"]>>>;
  try { prepared = await ports.prepareRequest({ ...input.invocation,
    extra_prompt:`Resident generation ${child.generation}. Report run ${runId} with resident_generation=${child.generation}, then remain available.` },runId); }
  catch(error) {
    // No spawn is permitted in preparation. Preserve any sealed Actio/run result
    // and release only this request's busy claim on a definitive preparation error.
    ports.residents.result(runId,child.generation);
    ports.residents.failRequest(input.parentId,key,error instanceof Error ? error.message : "preparation_failed");
    throw error;
  }
  if (!prepared.ok) {
    // Render-only validation cannot have spawned a process. Release the busy work
    // reservation, retain the failed receipt, and reuse the same resident later.
    ports.residents.result(runId,child.generation);
    ports.residents.failRequest(input.parentId,key,prepared.error);
    throw new Error(prepared.error);
  }
  const text = prepared.text;
  // Recheck ownership immediately before external I/O. No automatic reissue on error.
  const latestParent = ports.sessions.findSession(input.parentId);
  if (!latestParent || latestParent.status !== "active" || latestParent.repo_path !== parentBinding.repoPath
    || latestParent.repo_origin !== parentBinding.origin || latestParent.branch !== parentBinding.branch
    || readSubsidiaryId(latestParent.metadata) !== parentBinding.subsidiary
    || latestParent.current_task !== parentBinding.task || latestParent.target_project !== parentBinding.targetProject) {
    // No delivery was attempted. Keep the sealed run and failed receipt, without
    // changing the child's current report pointer or retrying this request.
    if (ports.runs.findRun(runId)) ports.runs.updateRunStatus(runId,"failed","resident_parent_binding_changed");
    ports.residents.result(runId,child.generation);
    ports.residents.failRequest(input.parentId,key,"resident_parent_binding_changed");
    throw new Error("resident_parent_binding_changed");
  }
  const latest = ports.sessions.findSession(session.id);
  const latestMarker = readResidentMarker(latest?.metadata ?? null);
  if (latest?.status !== "active" || latestMarker?.generation !== child.generation
    || latestMarker.id !== child.id || latestMarker.parentId !== child.parent_id) {
    ports.residents.delivery(input.parentId,key,"unknown"); throw new Error("resident_ownership_lost");
  }
  // Enrollment environment is immutable. Readers use this current metadata
  // pointer; historical run rows remain unchanged and late reports retain IDs.
  ports.runs.claimChildSession(runId,session.id);
  ports.runs.reuseRunWorkspace(runId,old);
  ports.sessions.mergeMetadata(session.id,{delegation_run_id:runId,
    delegation_parent_session_id:child.parent_id,delegation_call_name:input.invocation.call_name});
  let delivered: "delivered" | "unknown" = "unknown";
  try { delivered = await ports.deliver(session.id,text,runId); }
  finally { ports.residents.delivery(input.parentId,key,delivered); }
  return { ...receipt,delivery:delivered };
}
export function prepareResidentChild(ports: ResidentSidecarPorts, input: {
  parentId: string; packet: SidecarPacket; organization: string; model: string;
}): { child: ResidentChild; receipt: ResidentReceipt } {
  const id = randomUUID(); const generation = randomUUID(); const runId = randomUUID();
  const child: ResidentChild = { id,parent_id:input.parentId,generation,repo_path:input.packet.repo_path,
    organization:input.organization,provider:"codex",model:input.model,state:"starting",
    child_session_id:null,current_run_id:runId,branch:input.packet.child_branch };
  const receipt: ResidentReceipt = { parent_id:input.parentId,request_key:sidecarRequestKey(input.packet),
    child_id:id,generation,run_id:runId,delivery:"prepared" };
  if (!ports.residents.reserve(child,receipt,ports.now())) throw new Error("resident_already_reserved");
  return { child,receipt };
}
