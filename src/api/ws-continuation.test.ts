import {describe,it,expect,vi} from "vitest";
import {EventEmitter} from "node:events";
import type {Server as HttpServer} from "node:http";
import {attachWsServer} from "./ws.js";
import {TaskflowRuntime,type TaskflowRuntimeDeps} from "../taskflow/runtime.js";
import {eventBus,type ConcordiaEvent} from "../events.js";
import {isAutomaticContinuationSource} from "../control/automatic-continuation-policy.js";

interface MockSocket extends EventEmitter {readyState:number;send:ReturnType<typeof vi.fn>}
interface MockServer {clients:Set<MockSocket>;emit:(type:string,...args:unknown[])=>void}
const transport=vi.hoisted(()=>({server:null as MockServer | null}));
vi.mock("ws",()=>({
  WebSocket:{OPEN:1},
  WebSocketServer:class {
    clients=new Set<MockSocket>();
    handlers=new Map<string,Array<(...args:unknown[])=>void>>();
    constructor(){transport.server=this;}
    on(type:string,handler:(...args:unknown[])=>void){const handlers=this.handlers.get(type) ?? [];handlers.push(handler);this.handlers.set(type,handlers);}
    emit(type:string,...args:unknown[]){for(const handler of this.handlers.get(type) ?? []) handler(...args);}
    close(){for(const socket of this.clients) socket.emit("close");this.clients.clear();}
  },
}));
// This test observes the real TaskflowRuntime event dispatch, not its DB policy.
vi.mock("../taskflow/completion-blackbox.js",()=>({CompletionBlackbox:class {}}));

class Client extends EventEmitter {
  readyState=1;send=vi.fn();ping=vi.fn();
  terminate(){this.emit("close");}
}
describe("PTY continuation gate keeps observable evidence",() => {
  it("routes through attachWsServer without sending a refused command or hiding review dispatch",()=>{
    const handle=attachWsServer({} as HttpServer);const server=transport.server!;
    const client=new Client();server.clients.add(client);server.emit("connection",client,{url:"/ws?session=s"});
    client.send.mockClear(); // The enrollment hello is independent of commands.
    const runtime=new TaskflowRuntime({} as TaskflowRuntimeDeps);
    const review=vi.spyOn(runtime as unknown as {handleRevisorNotice:(id:string)=>Promise<void>},"handleRevisorNotice").mockResolvedValue(undefined);
    const processing=runtime.start();const observed:ConcordiaEvent[]=[];
    const unsubscribe=eventBus.subscribe(event=>observed.push(event));let allowed=false;
    const remove=eventBus.registerInjectGate(()=>allowed);
    try {
      const event={type:"session.inject",target_session_id:"s",source:"revisor",text:"merged",ts:1} as const;
      eventBus.emit(event);
      expect(client.send).not.toHaveBeenCalled();expect(observed).toContain(event);expect(review).toHaveBeenCalledWith("s");
      allowed=true;eventBus.emit({...event,text:"updated",ts:2});
      expect(client.send).toHaveBeenCalledOnce();expect(client.send.mock.calls[0]![0]).toContain("updated");
      expect(review).toHaveBeenCalledTimes(2);
    } finally {remove();unsubscribe();processing.stop();handle.close();review.mockRestore();}
  });
  it("suppresses command delivery without hiding Revisor state from observers",()=>{
    const observed:ConcordiaEvent[]=[];const unsubscribe=eventBus.subscribe(ev=>observed.push(ev));
    const remove=eventBus.registerInjectGate(()=>false);
    try{const event={type:"session.inject",target_session_id:"s",source:"revisor",text:"merged",ts:1} as const;
      eventBus.emit(event);expect(observed).toContain(event);expect(eventBus.canDeliverInject(event)).toBe(false);
    }finally{remove();unsubscribe();}
  });
  it("does not classify a newly claimed human confirmation request as automatic work",()=>{
    expect(isAutomaticContinuationSource("taskflow:residual:decompose:human-confirmation")).toBe(false);
  });
});
