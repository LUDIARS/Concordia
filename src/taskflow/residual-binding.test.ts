import {describe,it,expect} from "vitest";
import type {SessionRow} from "../shared/types.js";
import {residualBinding,matchesResidualBinding} from "./residual-binding.js";
const session=()=>({id:"s",status:"active",repo_path:"repo",repo_origin:"origin",branch:"feature",metadata:"{}",
  current_task:"task",target_project:"project",team_id:"team",department_id:"department",active_repos:"[\"repo\"]"}) as SessionRow;
describe("residual work-target identity across awaits",()=>{
  it.each(["repo_path","repo_origin","branch","current_task","target_project","team_id","department_id","active_repos"] as const)("rejects a changed %s",key=>{
    const row=session();const expected=residualBinding(row);row[key]="changed";
    expect(matchesResidualBinding(expected,row)).toBe(false);
  });
  it("preserves the captured values when the repository mutates the same row object",()=>{
    const row=session();const expected=residualBinding(row);row.metadata=JSON.stringify({subsidiary_id:"other"});
    expect(matchesResidualBinding(expected,row)).toBe(false);
    expect(matchesResidualBinding(expected,null)).toBe(false);
    expect(matchesResidualBinding(expected,{...session(),status:"lost"})).toBe(false);
    expect(matchesResidualBinding(expected,session())).toBe(true);
  });
});
