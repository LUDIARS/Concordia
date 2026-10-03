import { describe, expect, it, vi } from "vitest";
import { checkResidual } from "./residual-blackbox.js";
import { eventBus,type ConcordiaEvent } from "../events.js";
import { isWaitingForHumanResponse } from "../control/human-response-confirmation.js";
import { readHumanWait } from "../control/human-wait.js";
import type {SessionRow} from "../shared/types.js";

function waitFixture(metadata = "{}") {
  const row={id:"session",status:"active",repo_path:"repo",repo_origin:"origin",branch:"feature",metadata} as SessionRow;
  const sessions={findSession:()=>row,mergeMetadata:vi.fn((_id:string,patch:object)=>{row.metadata=JSON.stringify({...JSON.parse(row.metadata ?? "{}"),...patch});}),appendEvent:vi.fn()};
  const store={findForProject:vi.fn(async()=>[] as Array<{path:string}>),nextExecutable:vi.fn(async()=>({path:"actio:next"})),relativePath:(task:{path:string})=>task.path};
  const input={sessionId:row.id,sessions,store,hasPendingQuestion:()=>false} as unknown as Parameters<typeof checkResidual>[0];
  return {row,sessions,store,input};
}

describe("residual confirmation delivery before claim",()=>{
  it.each([true,{active:true,summary:"approval",task_references:[],since:1}])("keeps explicit human wait without creating a latch, record or phase",async wait=>{
    const h=waitFixture(JSON.stringify({cc_human_wait:wait}));const before=h.row.metadata;
    const observed:ConcordiaEvent[]=[];const stop=eventBus.subscribe(event=>observed.push(event));
    try {expect(await checkResidual(h.input)).toBe("waiting");expect(h.row.metadata).toBe(before);
      expect(h.sessions.mergeMetadata).not.toHaveBeenCalled();expect(h.sessions.appendEvent).not.toHaveBeenCalled();expect(observed).toEqual([]);}
    finally {stop();}
  });
  it("leaves no false delivery record when a gate refuses and retries when it opens",async()=>{
    const h=waitFixture();const observed:ConcordiaEvent[]=[];const stop=eventBus.subscribe(event=>observed.push(event));
    const remove=eventBus.registerInjectGate(()=>false);
    try {expect(await checkResidual(h.input)).toBe("waiting");expect(h.sessions.mergeMetadata).not.toHaveBeenCalled();expect(h.sessions.appendEvent).not.toHaveBeenCalled();expect(observed).toEqual([]);}
    finally {remove();stop();}
    expect(await checkResidual(h.input)).toBe("decompose");expect(h.sessions.appendEvent).toHaveBeenCalledOnce();
  });
  it("allows the newly claimed confirmation to pass its own human latch",async()=>{
    const h=waitFixture();const delivered:ConcordiaEvent[]=[];
    const remove=eventBus.registerInjectGate(event=>!readHumanWait(h.row.metadata)
      && (event.source==="taskflow:residual:decompose:human-confirmation" || !isWaitingForHumanResponse(h.input.sessions,h.row.id)));
    const stop=eventBus.subscribe(event=>{if(event.type==="session.inject" && eventBus.canDeliverInject(event)) delivered.push(event);});
    try {expect(await checkResidual(h.input)).toBe("decompose");expect(isWaitingForHumanResponse(h.input.sessions,h.row.id)).toBe(true);
      expect(delivered).toHaveLength(1);expect(await checkResidual(h.input)).toBe("waiting");}
    finally {stop();remove();}
  });
  it("rechecks work binding after the project lookup before selecting or notifying",async()=>{
    const h=waitFixture();h.store.findForProject.mockImplementationOnce(async()=>{h.row.branch="other";return [{path:"actio:next"}];});
    expect(await checkResidual(h.input)).toBe("waiting");expect(h.store.nextExecutable).not.toHaveBeenCalled();expect(h.sessions.mergeMetadata).not.toHaveBeenCalled();
  });
  it("rechecks human wait after delegated lookup and before decomposition",async()=>{
    const h=waitFixture();h.store.findForProject.mockImplementationOnce(async()=>[]).mockImplementationOnce(async()=>{
      h.row.metadata=JSON.stringify({cc_human_wait:{active:true,summary:"approval",task_references:[],since:1}});return [];
    });expect(await checkResidual(h.input)).toBe("waiting");expect(h.sessions.appendEvent).not.toHaveBeenCalled();expect(h.sessions.mergeMetadata).not.toHaveBeenCalled();
  });
  it("does not repeat a goal-and-go disabled question after a wait appears during task selection",async()=>{
    const h=waitFixture(JSON.stringify({goal_and_go:{enabled:false}}));h.store.findForProject.mockResolvedValue([{path:"actio:next"}]);
    h.store.nextExecutable.mockImplementationOnce(async()=>{h.row.metadata=JSON.stringify({cc_human_wait:true});return {path:"actio:next"};});
    const observed:ConcordiaEvent[]=[];const stop=eventBus.subscribe(event=>observed.push(event));
    try {expect(await checkResidual(h.input)).toBe("waiting");expect(h.sessions.mergeMetadata).not.toHaveBeenCalled();expect(observed).toEqual([]);}
    finally {stop();}
  });
});

describe("Actio residual continuation", () => {
  function fixture(blocked = false) {
    const nextExecutable = vi.fn(async () => blocked ? null : { path: "actio:critical" });
    const input = { sessionId: "session", sessions: { findSession: () => ({ id:"session",status:"active",repo_path: "repo", metadata: "{}" }) },
      store: { findForProject: async () => [{ path: "actio:first" }, { path: "actio:critical" }], nextExecutable,
        relativePath: (task: { path: string }) => task.path } } as unknown as Parameters<typeof checkResidual>[0];
    return { input, nextExecutable };
  }
  it("uses the authoritative executable selection instead of list order", async () => {
    const { input } = fixture();
    const texts: string[] = [];
    const stop = eventBus.subscribe((event) => { if (event.type === "taskflow.continue_requested") texts.push(event.text); });
    try { expect(await checkResidual(input)).toBe("next-task"); expect(texts).toEqual([expect.stringContaining("actio:critical")]); }
    finally { stop(); }
  });
  it("waits when every remaining task is blocked", async () => {
    const { input } = fixture(true);
    expect(await checkResidual(input)).toBe("waiting");
  });
  it("keeps unanswered human questions ahead of candidate selection", async () => {
    const { input, nextExecutable } = fixture();
    input.hasPendingQuestion = () => true;
    expect(await checkResidual(input)).toBe("waiting");
    expect(nextExecutable).not.toHaveBeenCalled();
  });
});
