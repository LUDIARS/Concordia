import {describe,it,expect} from "vitest";
import {decideAutomaticContinuation,isAutomaticContinuationSource} from "./automatic-continuation-policy.js";
const tracking={active:true,humanWait:false,pendingQuestion:false,humanConfirmation:false,residentIdle:false,bindingMatches:true} as const;
describe("SC-WAIT shared automatic continuation",() => {
  it("work/delegation/review tracking remains eligible without human waiting",() => expect(decideAutomaticContinuation(tracking).allow).toBe(true));
  it.each([{humanWait:true},{pendingQuestion:true},{humanConfirmation:true}])("suppresses explicit human waiting",(patch)=>expect(decideAutomaticContinuation({...tracking,...patch}).reason).toBe("waiting_human"));
  it("keeps unknown and ownership changes separate from human waiting",() => {
    expect(decideAutomaticContinuation({...tracking,pendingQuestion:"unknown"}).reason).toBe("question_state_unknown");
    expect(decideAutomaticContinuation({...tracking,bindingMatches:false}).reason).toBe("binding_changed");
    expect(decideAutomaticContinuation({...tracking,residentIdle:true}).reason).toBe("resident_idle");
  });
  it("covers watchdog and inquiry sources while preserving explicit stop delivery",() => {
    for(const source of ["auto:stall-nudge","auto:inquiry","delegation:run:watchdog","taskflow:continue","revisor:approved"]) expect(isAutomaticContinuationSource(source)).toBe(true);
    expect(isAutomaticContinuationSource("auto:session-end")).toBe(false);expect(isAutomaticContinuationSource("discord:human:channel:message")).toBe(false);
  });
});
