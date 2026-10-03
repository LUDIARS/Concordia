import {describe,it,expect} from "vitest";
import {parseOfficialModel} from "./codex-provider.js";
import {resolveCodexModelCommand} from "./codex-command.js";
describe("official provider boundary",() => {
  it("maps official capabilities without accepting cache fields or malformed upgrades",() => {
    const value={model:"gpt-6.1-sol",hidden:false,upgrade:null,supportedReasoningEfforts:[{reasoningEffort:"medium"}],inputModalities:["text"]};
    expect(parseOfficialModel(value).capabilities.reasoningEfforts).toEqual(["medium"]);
    expect(()=>parseOfficialModel({...value,upgrade:{model:"gpt-7-sol"}})).toThrow();
    expect(()=>parseOfficialModel({...value,supportedReasoningEfforts:["medium"]})).toThrow();
    expect(()=>parseOfficialModel({slug:"gpt-6.1-sol"})).toThrow();
  });
  it("explicitly rejects Windows shell shims and an unavailable executable",async () => {
    await expect(resolveCodexModelCommand({platform:"win32",path:"",nodeExecutable:"node",explicit:"codex.cmd"})).rejects.toThrow("shell_shim");
    await expect(resolveCodexModelCommand({platform:"win32",path:"",nodeExecutable:"node"})).rejects.toThrow("unavailable");
  });
});
