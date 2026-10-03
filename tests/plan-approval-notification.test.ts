import { describe, it, expect } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";
import { eventBus, type ConcordiaEvent } from "../src/events.js";

function setup() {
  const env = makeTestApp();
  for (const id of ["plan-a","plan-b"]) env.repo.insertSession({id,provider:"claude-code",repo_path:"/project",repo_origin:null,branch:"main",host:"test",started_at:1,last_seen_at:1,transcript_path:null,metadata:null});
  const post = (session: string, request: string | undefined, question = "approve this plan") => env.app.request(`/v1/sessions/${session}/pending-question`, {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"plan_approval",provider_request_id:request,question,options:["approve","reject"]}),
  });
  return {env,post};
}
describe("typed plan approval", () => {
  it("deduplicates by provider request across answered replay, not by identical text", async () => {
    const {env,post} = setup();
    const events: ConcordiaEvent[] = [];
    const stop = eventBus.subscribe(e=>events.push(e));
    try {
      const first = await (await post("plan-a","req-1")).json();
      env.pendingQuestions.markAnswered(first.question_id,0,"approve");
      expect(await (await post("plan-a","req-1")).json()).toMatchObject({question_id:first.question_id,deduped:true});
      const second = await (await post("plan-a","req-2")).json();
      const other = await (await post("plan-b","req-1")).json();
      expect(second.question_id).not.toBe(first.question_id);
      expect(other.question_id).not.toBe(first.question_id);
      expect(events.filter(e=>e.type === "question.posted")).toHaveLength(3);
      expect(events).toContainEqual(expect.objectContaining({type:"question.posted",kind:"plan_approval",provider_request_id:"req-1"}));
      expect(env.pendingQuestions.findByProviderRequest("plan-a","req-1")?.answer_text).toBe("approve");
    } finally {stop();}
  });
  it("requires identity and rejects reuse with changed content", async () => {
    const {post} = setup();
    expect((await post("plan-a",undefined)).status).toBe(400);
    expect((await post("plan-a","req-1")).status).toBe(200);
    expect((await post("plan-a","req-1","different plan")).status).toBe(409);
  });
});
