import {describe,expect,it} from "vitest";
import {makeTestDb} from "../../tests/helpers/db.js";
import {DelegationRepo} from "../db/delegation-repo.js";
import {seedDelegationTemplates} from "./seed.js";

describe("standard delegation profile upgrade",()=>{
  it("preserves identity, an edited prompt and a model pin through rename and repeated seeding",()=>{
    const repo=new DelegationRepo(makeTestDb());
    const old=repo.createTemplate({call_name:"sol-mid",title:"Sol",target_provider:"codex",model:"gpt-5.6-sol",prompt_template:"old"});
    repo.updateTemplate(old.id,{prompt_template:"operator-owned prompt"});
    repo.pinTemplateModel(old.id);
    seedDelegationTemplates(repo);
    seedDelegationTemplates(repo);
    expect(repo.findTemplate(old.id)).toMatchObject({call_name:"sol-6-1",model:"gpt-5.6-sol",prompt_template:"operator-owned prompt"});
    expect(repo.findTemplateByCallName("sol-mid")?.id).toBe(old.id);
    expect(repo.isModelFollowing(old.id)).toBe(false);
    expect(repo.findTemplateByCallName("sol-xhigh")).toBeNull();
  });
  it("offers versioned profiles with initial medium and adjustable effort without movable labels",()=>{
    const repo=new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);
    const sol=repo.findTemplateByCallName("sol-6-1")!;
    expect(JSON.parse(sol.runtime_options_json)).toEqual({model_reasoning_effort:"medium"});
    expect(sol.title).toContain("6.1");
    expect(repo.findTemplateByCallName("sonnet-5-5")?.model).toBe("claude-sonnet-5-5");
    for(const name of ["sol-6-1","sonnet-5-5","opus-5-5","fable-5-1"]) {
      const profile=repo.findTemplateByCallName(name)!;
      expect(profile.title).not.toContain("movable");
      expect(profile.call_name).not.toContain("movable");
      expect(profile.prompt_template).toContain("/v1/sessions/<your Concordia session id>/effort");
    }
  });
  it("keeps both identities rather than replacing an existing canonical profile on collision",()=>{
    const repo=new DelegationRepo(makeTestDb());
    const old=repo.createTemplate({call_name:"sol-mid",title:"old",target_provider:"codex",prompt_template:"old"});
    const current=repo.createTemplate({call_name:"sol-6-1",title:"current",target_provider:"codex",prompt_template:"current"});
    expect(()=>repo.renameTemplateCallName("sol-mid","sol-6-1")).toThrow("delegation_template_name_collision");
    expect(repo.findTemplate(old.id)?.call_name).toBe("sol-mid");
    expect(repo.findTemplate(current.id)?.prompt_template).toBe("current");
  });
});
