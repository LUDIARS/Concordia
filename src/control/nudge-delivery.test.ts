import {describe,it,expect} from "vitest";
import type {SessionsRepo} from "../db/sessions-repo.js";
import {claimNudgeDelivery,startNudgeProgress} from "./nudge-delivery.js";
import {recoverLegacyNudgeConfirmations,humanResponseSession} from "./human-response-confirmation.js";
import {eventBus} from "../events.js";
describe("SC-WAIT durable nudge delivery",() => {
  function setup(){let metadata:Record<string,unknown>={};const row={id:"s",status:"active",metadata:"{}"};
    const repo={findSession:()=>row,findAllActive:()=>[row],updateMetadata:(_id:string,fn:(v:Record<string,unknown>)=>Record<string,unknown>)=>{metadata=fn(metadata);row.metadata=JSON.stringify(metadata);},
      mergeMetadata:(_id:string,patch:Record<string,unknown>)=>{metadata={...metadata,...patch};row.metadata=JSON.stringify(metadata);}} as unknown as SessionsRepo;
    return {repo,row,get metadata(){return metadata;},set metadata(value:Record<string,unknown>){metadata=value;row.metadata=JSON.stringify(value);}};}
  it("survives restart and reopens on AI activity or an external work transition",() => {
    const h=setup();expect(claimNudgeDelivery(h.repo,"s",100,200)).toBe(true);expect(claimNudgeDelivery(h.repo,"s",100,300)).toBe(false);
    expect(claimNudgeDelivery(h.repo,"s",201,300)).toBe(true);expect(h.metadata.human_response_confirmation).toBeUndefined();
    const watch=startNudgeProgress(h.repo);try {eventBus.emit({type:"delegation.run_changed",parent_session_id:"s",run_id:"r",status:"completed",ts:1});
      expect(claimNudgeDelivery(h.repo,"s",201,1100)).toBe(true);}finally{watch.stop();}
  });
  it("recovers old nudge latches while preserving explicit human wait and modern confirmation",() => {
    const h=setup();h.metadata={human_response_confirmation:true,human_response_confirmation_source:"auto:stall-nudge",cc_human_wait:{active:true,summary:"approval"}};
    recoverLegacyNudgeConfirmations(h.repo);expect(h.metadata.human_response_confirmation).toBe(false);expect(h.metadata.cc_human_wait).toEqual({active:true,summary:"approval"});
    h.metadata={human_response_confirmation:true,human_response_confirmation_source:"explicit_human_confirmation"};recoverLegacyNudgeConfirmations(h.repo);expect(h.metadata.human_response_confirmation).toBe(true);
    h.metadata={human_response_confirmation:true};recoverLegacyNudgeConfirmations(h.repo);expect(h.metadata.human_response_confirmation).toBe(true);
  });
  it("typing/activity and AI echoes do not count as human answers",() => {
    expect(humanResponseSession({type:"session.event",session_id:"s",kind:"user_activity",ts:1})).toBeNull();
    expect(humanResponseSession({type:"session.inject",target_session_id:"s",text:"echo",source:"auto:stall-nudge",ts:1})).toBeNull();
  });
});
