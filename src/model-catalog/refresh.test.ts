import { describe,it,expect,vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ModelRoleRepo } from "../db/model-role-repo.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { seedInitialRoles } from "./initial-roles.js";
import { refreshModelRoles } from "./refresh.js";
import { startDailyModelRefresh } from "./daily-refresh.js";
const now = Date.parse("2026-10-03T01:00:00Z");
function setup() { const db=makeTestDb();const delegation=new DelegationRepo(db);
  const repo=new ModelRoleRepo(db,(before,next)=>delegation.followRoleModels(before,next));seedInitialRoles(repo,now);
  return {repo,delegation,db}; }
describe("SC-MODEL daily ownership and snapshot CAS",() => {
  it("recovers an expired lease, bounds retries, and never repeats a successful day",() => {
    const {repo}=setup();expect(repo.claim("2026-10-03","a",now,100)).toBe(true);
    expect(repo.claim("2026-10-03","b",now+99,100)).toBe(false);
    expect(repo.claim("2026-10-03","b",now+100,100)).toBe(true);
    repo.finish("2026-10-03","a",now+100,"stale owner",true);
    expect(repo.owns("2026-10-03","b",now+101)).toBe(true);
    repo.finish("2026-10-03","b",now+101,"ok",true);
    expect(repo.claim("2026-10-03","c",now+1_000,100)).toBe(false);
    for(let attempt=0;attempt<3;attempt++){expect(repo.claim("2026-10-04",`owner${attempt}`,now+attempt*1000,100)).toBe(true);}
    expect(repo.claim("2026-10-04","fourth",now+10_000,100)).toBe(false);
  });
  it("keeps snapshots after provider failure, reports the reason, and retries after cooldown",async () => {
    const {repo}=setup();const before=repo.find("codex","sol");
    const provider={discover:vi.fn().mockRejectedValue(new Error("provider_offline"))};
    expect(await refreshModelRoles({repo,provider,owner:"a",now:()=>now,signal:new AbortController().signal})).toBe("provider_offline");
    expect(repo.find("codex","sol")).toEqual(before);expect(repo.refreshStatus()?.status).toBe("failed");
    await refreshModelRoles({repo,provider,owner:"b",now:()=>now+1,signal:new AbortController().signal});expect(provider.discover).toHaveBeenCalledTimes(1);
  });
  it("adopts validated fresh data and preserves explicit same-ID template pins",async () => {
    const {repo,delegation}=setup();
    const tpl=delegation.createTemplate({call_name:"sol-mid",title:"Sol",target_provider:"codex",model:"gpt-6.1-sol",prompt_template:"task"});
    delegation.trackTemplateModel(tpl.id);delegation.pinTemplateModel(tpl.id);
    const provider={discover:vi.fn().mockResolvedValue({source:"codex:model/list:v1",observedAt:new Date(now).toISOString(),models:[
      {modelId:"gpt-6.2-sol",upgrade:null,hidden:false,capabilities:{reasoningEfforts:["medium","xhigh"],inputModalities:["text"]}}]})};
    await refreshModelRoles({repo,provider,owner:"a",now:()=>now,signal:new AbortController().signal,revision:()=>"new"});
    expect(repo.find("codex","sol")?.modelId).toBe("gpt-6.2-sol");expect(delegation.findTemplate(tpl.id)?.model).toBe("gpt-6.1-sol");
    await refreshModelRoles({repo,provider,owner:"b",now:()=>now+100,signal:new AbortController().signal});expect(provider.discover).toHaveBeenCalledTimes(1);
    expect(repo.adopt("wrong",{...repo.find("codex","sol")!,revision:"invalid"},"conflict",now)).toBe(false);
  });
  it("does not overwrite a concurrent pin and rollback selects a new pinned revision",() => {
    const {repo}=setup();const current=repo.find("codex","sol")!;
    expect(repo.adopt(current.revision,{...current,revision:"history",modelId:"gpt-6.2-sol"},"update",now)).toBe(true);
    expect(repo.adopt(current.revision,{...current,revision:"stale"},"stale",now)).toBe(false);
    expect(repo.rollback("codex","sol","history","rollback",now)).toBe(true);expect(repo.find("codex","sol")?.pinned).toBe(true);
  });
  it("owns its timer and aborts I/O on stop",async () => {
    vi.useFakeTimers();
    try { const {repo}=setup();let signal:AbortSignal | undefined;
      const provider={discover:vi.fn((s:AbortSignal)=>{signal=s;return new Promise<never>(()=>{});})};
      const handle=startDailyModelRefresh({repo,provider,now:()=>now,log:{warn:vi.fn()}});
      expect(provider.discover).toHaveBeenCalledTimes(1);handle.stop();expect(signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {vi.useRealTimers();}
  });
});
