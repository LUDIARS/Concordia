/** Reconcile persisted generation; terminal runs do not end a resident child. */
import { eventBus } from "../../events.js";
import { scheduleTeardownLadder } from "../../taskflow/teardown-ladder.js";
import { readResidentMarker } from "./lifecycle-policy.js";
import type { ResidentSidecarPorts } from "./resident-service.js";
import type { ResidentChild } from "./lifecycle-policy.js";
import { createChildLogger } from "../../shared/logger.js";
const log = createChildLogger("resident-sidecar");
export function closeResidentSidecar(ports:ResidentSidecarPorts,child:ResidentChild,reason:string): void {
  const session = child.child_session_id ? ports.sessions.findSession(child.child_session_id) : null;
  const marker = readResidentMarker(session?.metadata ?? null);
  if (!session || marker?.id !== child.id || marker.generation !== child.generation || marker.parentId !== child.parent_id) {
    ports.residents.close(child.id,child.generation,false,"ownership_unknown"); return;
  }
  ports.residents.close(child.id,child.generation,false,reason);
  scheduleTeardownLadder(ports.sessions,session,`resident:${child.generation}`,Math.floor(ports.now()/1000));
}
export function reconcileResidentSidecars(ports: ResidentSidecarPorts): void {
  for (const child of ports.residents.list()) {
    const run = child.current_run_id ? ports.runs.findRun(child.current_run_id) : null;
    const childId = child.child_session_id ?? run?.child_session_id ?? null;
    const session = childId ? ports.sessions.findSession(childId) : null;
    const parent = ports.sessions.findSession(child.parent_id);
    if (child.state === "starting" && session && run) {
      const existing = readResidentMarker(session.metadata);
      if (existing && (existing.id !== child.id || existing.generation !== child.generation || existing.parentId !== child.parent_id)) {
        ports.residents.close(child.id,child.generation,false,"generation_conflict"); continue;
      }
      ports.sessions.mergeMetadata(session.id,{ cc_resident_child:{id:child.id,generation:child.generation,parentId:child.parent_id},teardown_ladder:null });
      ports.residents.attach(child.id,child.generation,run.id,session.id);
    }
    // Unknown presence stays reserved. It is never permission to launch another child.
    if (!session) continue;
    const marker = readResidentMarker(ports.sessions.findSession(session.id)?.metadata ?? null);
    if (session.status === "ended") { ports.residents.close(child.id,child.generation,true,"child_ended"); continue; }
    if (marker?.id !== child.id || marker.generation !== child.generation || marker.parentId !== child.parent_id) {
      ports.residents.close(child.id,child.generation,false,"ownership_lost"); continue;
    }
    if (parent?.status === "lost" && child.state !== "closing") continue;
    if (!parent || parent.status !== "active" || child.state === "closing") {
      closeResidentSidecar(ports,{...child,child_session_id:session.id},"parent_or_ownership_lost");
      continue;
    }
    if (run && (run.status === "completed" || run.status === "failed")) ports.residents.result(run.id,child.generation);
  }
}
export function startResidentSidecars(ports: ResidentSidecarPorts): { stop(): void } {
  const reconcile = (): void => {
    try { reconcileResidentSidecars(ports); }
    catch (error) { log.warn({error},"resident reconciliation failed; reservations retained"); }
  };
  const unsubscribe = eventBus.subscribe((event) => {
    if (event.type === "session.started" || event.type === "session.ended" || event.type === "delegation.run_changed") reconcile();
  });
  const timer = setInterval(reconcile,30_000); timer.unref(); reconcile();
  return { stop() { clearInterval(timer); unsubscribe(); } };
}
