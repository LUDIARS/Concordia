import {describe,it,expect} from "vitest";
import {makeTestDb} from "./helpers/db.js";
import {ModelRoleRepo} from "../src/db/model-role-repo.js";
import {ModelCatalogRepo} from "../src/db/model-catalog-repo.js";
import {seedInitialRoles} from "../src/model-catalog/initial-roles.js";
import {modelCatalogRouter} from "../src/api/model-catalog.js";
describe("role API compatibility and explicit errors",() => {
  it("adds versioned role resolution while preserving candidate CRUD",async()=>{
    const db=makeTestDb();const roles=new ModelRoleRepo(db);const now=Date.parse("2026-10-03T00:00:00Z");seedInitialRoles(roles,now);
    const router=modelCatalogRouter({repo:new ModelCatalogRepo(db),roles,now:()=>now});
    const role=await router.request("/roles/codex/sol");expect(role.status).toBe(200);expect(await role.json()).toMatchObject({schemaVersion:1,modelId:"gpt-6.1-sol"});
    expect((await router.request("/roles/claude/sol")).status).toBe(404);
    expect((await router.request("/roles/codex/sol?context=unknown")).status).toBe(503);
    expect((await router.request("/",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"codex",model_id:"manual"})})).status).toBe(201);
    const current=roles.find("codex","sol")!;
    expect((await router.request("/roles/codex/sol",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({pinned:true,expectedRevision:current.revision})})).status).toBe(200);
    expect(roles.find("codex","sol")?.pinned).toBe(true);
    expect((await router.request("/roles/codex/sol",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({pinned:false,expectedRevision:current.revision})})).status).toBe(409);
  });
});
