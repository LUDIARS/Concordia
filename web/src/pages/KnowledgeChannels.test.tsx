// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect,it,vi } from "vitest";
import { api } from "../api.js";
import { KnowledgeChannels } from "./KnowledgeChannels.js";

it("lists a saved Discord channel and removes it using the same channel link",async()=>{
  vi.spyOn(api,"knowledgeChannels").mockResolvedValue({channels:[{platform:"discord",team:"123",channel:"456"}]});
  const change=vi.spyOn(api,"knowledgeChannelSet").mockResolvedValue({channels:[]});
  const container=document.createElement("div"), root=createRoot(container);
  try{
    await act(async()=>{root.render(<KnowledgeChannels/>);});
    expect(container.textContent).toContain("123/456");
    await act(async()=>{container.querySelector("li button")?.dispatchEvent(new MouseEvent("click",{bubbles:true}));});
    expect(change).toHaveBeenCalledWith("https://discord.com/channels/123/456",false);
    expect(container.querySelector("li")).toBeNull();
  }finally{await act(async()=>root.unmount());vi.restoreAllMocks();}
});
