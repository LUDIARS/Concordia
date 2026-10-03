import {describe,it,expect,vi} from "vitest";
import {createHttpModelCatalogPort} from "./http-port.js";
describe("structural catalog HTTP consumer",() => {
  const now=Date.parse("2026-10-03T00:00:00Z");
  const snapshot={schemaVersion:1,provider:"codex",role:"sol",modelId:"gpt-6.1-sol",revision:"r1",observedAt:new Date(now).toISOString(),expiresAt:new Date(now+60_000).toISOString(),source:"official",pinned:false,capabilities:{reasoningEfforts:["medium"],inputModalities:["text"]}};
  it("uses the injected endpoint and sees a new revision on the next call",async () => {
    const request=vi.fn().mockResolvedValueOnce(Response.json(snapshot)).mockResolvedValueOnce(Response.json({...snapshot,revision:"r2",modelId:"gpt-6.2-sol"}));
    const port=createHttpModelCatalogPort({resolveEndpoint:async()=>"http://catalog.test",fetch:request,now:()=>now});
    expect((await port.resolve({provider:"codex",role:"sol"})).revision).toBe("r1");
    expect((await port.resolve({provider:"codex",role:"sol"})).modelId).toBe("gpt-6.2-sol");
  });
  it.each([{...snapshot,schemaVersion:2},{...snapshot,provider:"claude"},{...snapshot,expiresAt:new Date(now).toISOString()},{...snapshot,observedAt:new Date(now+1).toISOString()}])("rejects invalid or stale snapshots",async (value) => {
    const port=createHttpModelCatalogPort({resolveEndpoint:async()=>"http://catalog.test",fetch:vi.fn().mockResolvedValue(Response.json(value)),now:()=>now});
    await expect(port.resolve({provider:"codex",role:"sol"})).rejects.toThrow();
  });
});
