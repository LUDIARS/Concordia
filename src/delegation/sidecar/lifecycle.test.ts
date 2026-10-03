import {describe,it,expect,vi} from "vitest";
import {makeTestDb} from "../../../tests/helpers/db.js";
import {DelegationRepo} from "../../db/delegation-repo.js";
import type {SessionsRepo} from "../../db/sessions-repo.js";
import type {SessionRow} from "../../shared/types.js";
import {ResidentSidecarRepo} from "./lifecycle-repo.js";
import {prepareResidentChild,continueResidentSidecar,type ResidentSidecarPorts} from "./resident-service.js";
import {reconcileResidentSidecars,closeResidentSidecar} from "./resident-runtime.js";
import {readResidentMarker,matchesResidentResult} from "./lifecycle-policy.js";
import type {SidecarPacket} from "./packet.js";
const packet:SidecarPacket={task_reference:"actio:task",request_version:1,authorization_ref:"discord:human",repo_path:"/repo",origin:"https://example.test/repo",base_commit:"a".repeat(40),child_branch:"feature/task",objective:"Change a label",design_refs:["spec/design"],editable_paths:["src/label"],acceptance:["Label matches"],forbidden:[],open_questions:[],verification:"tests authorized separately",completion_scope:"commit",budget:{max_minutes:20}};
function setup(){const db=makeTestDb();const runs=new DelegationRepo(db);const residents=new ResidentSidecarRepo(db);
  const rows=new Map<string,SessionRow>(["parent","child"].map(id=>[id,{id,status:"active",metadata:"{}",provider:"codex-cli",repo_path:"/repo",branch:"feature/task"} as SessionRow]));
  const sessions={findSession:(id:string)=>rows.get(id) ?? null,mergeMetadata:(id:string,patch:object)=>{const row=rows.get(id)!;row.metadata=JSON.stringify({...JSON.parse(row.metadata ?? "{}"),...patch});},appendEvent:vi.fn()} as unknown as SessionsRepo;
  const ports:ResidentSidecarPorts={residents,runs,sessions,now:()=>1000,deliver:vi.fn().mockResolvedValue("unknown"),prepareRequest:async(input,id)=>{
    runs.createRun({id,template_id:null,call_name:"sol-mid",target_provider:"codex",parent_session_id:"parent",args:{taskflow_reference:"actio:sealed"},rendered_prompt:"Read Actio task",prompt_file_path:"prompt",spawn_pid:null,spawn_command:null,triggered_by:null,status:"pending"});return {ok:true,text:"Read Actio task"};}};
  const reserved=prepareResidentChild(ports,{parentId:"parent",packet,organization:"",model:"gpt-6.1-sol"});
  runs.createRun({id:reserved.receipt.run_id,template_id:null,call_name:"sol-mid",target_provider:"codex",parent_session_id:"parent",child_session_id:"child",args:{},rendered_prompt:"initial",prompt_file_path:"prompt",spawn_pid:null,spawn_command:null,triggered_by:null,status:"running",effective_model:"gpt-6.1-sol",spawn_cwd:"/repo",spawn_branch:"feature/task"});
  reconcileResidentSidecars(ports);return {ports,rows,reserved};}
describe("SC-LIFE resident requests and generation ownership",() => {
  it.each(["ended","lost","repository","branch","subsidiary"])("refuses delivery after a parent %s change during validation",async change=>{
    const {ports,rows,reserved}=setup();ports.runs.updateRunStatus(reserved.receipt.run_id,"completed");reconcileResidentSidecars(ports);
    const prepare=ports.prepareRequest!;const before=rows.get("child")!.metadata;
    ports.prepareRequest=async(input,id)=>{const prepared=await prepare(input,id);const parent=rows.get("parent")!;
      if(change==="ended" || change==="lost") parent.status=change;
      if(change==="repository") parent.repo_path="/other";
      if(change==="branch") parent.branch="other";
      if(change==="subsidiary") parent.metadata=JSON.stringify({subsidiary_id:"other"});return prepared;};
    const next={parentId:"parent",packet:{...packet,request_version:2},organization:"",invocation:{call_name:"sol-mid",args:{}}};
    await expect(continueResidentSidecar(ports,next)).rejects.toThrow("resident_parent_binding_changed");
    expect(ports.deliver).not.toHaveBeenCalled();expect(rows.get("child")!.metadata).toBe(before);
    const receipt=ports.residents.receipt("parent","actio:task#v2")!;
    expect(receipt.delivery).toBe("failed");expect(ports.runs.findRun(receipt.run_id)?.status).toBe("failed");
    expect(ports.runs.findRun(reserved.receipt.run_id)?.status).toBe("completed");
    expect(await continueResidentSidecar(ports,next)).toEqual(receipt);expect(ports.deliver).not.toHaveBeenCalled();
  });
  it("retains its child and result reservation during temporary parent loss",()=>{
    const {ports,rows}=setup(); const before=rows.get("child")!.metadata;
    rows.get("parent")!.status="lost"; reconcileResidentSidecars(ports);
    expect(ports.residents.findByParent("parent")?.state).toBe("busy");
    expect(rows.get("child")!.metadata).toBe(before);
    rows.get("parent")!.status="active"; reconcileResidentSidecars(ports);
    expect(ports.residents.findByParent("parent")?.state).toBe("busy");
  });
  it("keeps the same child after terminal work and sends the next sealed request exactly once",async()=>{
    const {ports,rows,reserved}=setup();ports.runs.updateRunStatus(reserved.receipt.run_id,"completed");reconcileResidentSidecars(ports);
    expect(ports.residents.findByParent("parent")?.state).toBe("idle");
    const next={parentId:"parent",packet:{...packet,request_version:2},organization:"",invocation:{call_name:"sol-mid",args:{}}};
    const receipt=await continueResidentSidecar(ports,next);expect(receipt?.generation).toBe(reserved.child.generation);
    expect(ports.runs.findRun(receipt!.run_id)?.child_session_id).toBe("child");expect(ports.runs.findRun(reserved.receipt.run_id)?.status).toBe("completed");
    expect(JSON.parse(rows.get("child")!.metadata!).delegation_run_id).toBe(receipt!.run_id);
    expect(await continueResidentSidecar(ports,next)).toEqual(ports.residents.receipt("parent","actio:task#v2"));expect(ports.deliver).toHaveBeenCalledTimes(1);
    expect(ports.deliver).toHaveBeenCalledWith("child","Read Actio task",receipt!.run_id);
  });
  it("holds unknown delivery across restart and rejects competing work or stale results",async()=>{
    const {ports,reserved}=setup();ports.runs.updateRunStatus(reserved.receipt.run_id,"completed");reconcileResidentSidecars(ports);
    const receipt=await continueResidentSidecar(ports,{parentId:"parent",packet:{...packet,request_version:2},organization:"",invocation:{call_name:"sol-mid",args:{}}});
    reconcileResidentSidecars(ports);expect(receipt?.delivery).toBe("unknown");
    await expect(continueResidentSidecar(ports,{parentId:"parent",packet:{...packet,request_version:3},organization:"",invocation:{call_name:"sol-mid",args:{}}})).rejects.toThrow("busy");
    const child=ports.residents.findByParent("parent")!;expect(matchesResidentResult(child,reserved.receipt.run_id,child.generation)).toBe(false);
    expect(ports.residents.result(reserved.receipt.run_id,child.generation)).toBe(false);expect(child.current_run_id).toBe(receipt?.run_id);
  });
  it("never overwrites or stops a foreign generation",()=>{
    const {ports,rows,reserved}=setup();ports.sessions.mergeMetadata("child",{cc_resident_child:{id:"foreign",generation:"foreign",parentId:"other"}});
    const before=rows.get("child")!.metadata;reconcileResidentSidecars(ports);closeResidentSidecar(ports,reserved.child,"stop");
    expect(rows.get("child")!.metadata).toBe(before);expect(ports.sessions.appendEvent).not.toHaveBeenCalled();
  });
  it("closes through normal lifecycle on parent end and retains work results",()=>{
    const {ports,rows,reserved}=setup();rows.get("parent")!.status="ended";reconcileResidentSidecars(ports);
    expect(ports.residents.findByParent("parent")?.state).toBe("closing");expect(JSON.parse(rows.get("child")!.metadata!).teardown_ladder.run_key).toBe(`resident:${reserved.child.generation}`);
    expect(ports.runs.findRun(reserved.receipt.run_id)).not.toBeNull();expect(readResidentMarker(rows.get("child")!.metadata)).not.toBeNull();
  });
  it("records deterministic preparation failure and reuses the same child for a later version",async()=>{
    const {ports,reserved}=setup();ports.runs.updateRunStatus(reserved.receipt.run_id,"completed");reconcileResidentSidecars(ports);
    ports.prepareRequest=async()=>({ok:false,error:"authorization_denied"});
    await expect(continueResidentSidecar(ports,{parentId:"parent",packet:{...packet,request_version:2},organization:"",invocation:{call_name:"sol-mid",args:{}}})).rejects.toThrow("authorization_denied");
    expect(ports.residents.findByParent("parent")?.state).toBe("idle");expect(ports.residents.receipt("parent","actio:task#v2")?.delivery).toBe("failed");
  });
});
