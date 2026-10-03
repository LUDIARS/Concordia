import { describe,it,expect } from "vitest";
import { decideRoleAdoption,dueRefreshDay,resolveRoleSnapshot,type RoleSnapshot,type ProviderModel } from "./role-policy.js";
const now = Date.parse("2026-10-03T01:00:00Z");
const current:RoleSnapshot = {schemaVersion:1,provider:"codex",role:"sol",modelId:"gpt-6.1-sol",revision:"r1",
  observedAt:new Date(now).toISOString(),expiresAt:new Date(now+86_400_000).toISOString(),
  capabilities:{reasoningEfforts:["medium","xhigh"],inputModalities:["text"]},source:"configured-bootstrap",pinned:false};
const model = (id:string,upgrade:string | null = null):ProviderModel => ({modelId:id,upgrade,hidden:false,capabilities:current.capabilities});
describe("SC-MODEL role adoption",() => {
  it("uses official numeric versions when upgrade is null, including 6.10 above 6.2",() => {
    const decision = decideRoleAdoption({current,candidates:[model(current.modelId),model("gpt-6.2-sol"),model("gpt-6.10-sol")],source:"codex:model/list:v1"});
    expect(decision.model?.modelId).toBe("gpt-6.10-sol");
  });
  it("rejects an official downgrade edge and an incapable edge",() => {
    expect(decideRoleAdoption({current,candidates:[model(current.modelId,"gpt-6-sol"),model("gpt-6-sol")],source:"codex:model/list:v1"}).reason).toBe("automatic_downgrade_rejected");
    const incapable = {...model("gpt-6.2-sol"),capabilities:{reasoningEfforts:["medium"],inputModalities:["text"]}};
    expect(decideRoleAdoption({current,candidates:[model(current.modelId,"gpt-6.2-sol"),incapable],source:"codex:model/list:v1"}).reason).toBe("capability_mismatch");
  });
  it("ignores preview, other roles and arbitrary names; preserves manual pins",() => {
    const candidates = [model(current.modelId),model("gpt-7-preview-sol"),model("gpt-9-astra"),model("sol-next")];
    expect(decideRoleAdoption({current,candidates,source:"codex:model/list:v1"}).model?.modelId).toBe(current.modelId);
    expect(decideRoleAdoption({current:{...current,pinned:true},candidates,source:"codex:model/list:v1"}).reason).toBe("manual_pin");
    expect(decideRoleAdoption({current,candidates,source:"old-cache"}).model).toBeNull();
  });
  it("rejects expired, future and overlong snapshots and unknown contexts",() => {
    expect(resolveRoleSnapshot(current,now)).toEqual(current);
    for (const snapshot of [{...current,expiresAt:new Date(now).toISOString()},
      {...current,observedAt:new Date(now+1).toISOString()},
      {...current,expiresAt:new Date(now+72*3_600_000).toISOString()}]) expect(() => resolveRoleSnapshot(snapshot,now)).toThrow();
    expect(() => resolveRoleSnapshot(current,now,"unknown")).toThrow("model_context_unsupported");
  });
  it("runs only after JST 10, with a stable local calendar day",() => {
    expect(dueRefreshDay(now-1)).toBeNull(); expect(dueRefreshDay(now)).toBe("2026-10-03");
    expect(dueRefreshDay(Date.parse("2026-10-03T14:59:00Z"))).toBe("2026-10-03");
    expect(dueRefreshDay(Date.parse("2026-10-03T15:00:00Z"))).toBeNull();
  });
});
