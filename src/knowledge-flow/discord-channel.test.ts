import Database from "better-sqlite3";
import type { Client, Message } from "discord.js";
import { expect, it, vi } from "vitest";
import { discordArticleFlow } from "../discord/knowledge-flow.js";
import { knowledgeChannelsRouter } from "../api/knowledge-channels.js";
import { watchedChannels } from "./watched-channels.js";
import { seedJobs, notifyArticle } from "./article-ledger.js";
import { startThreadDelivery } from "./thread-delivery.js";

const guild="123456789012345678", channel="223456789012345678", post="323456789012345678";
const url="https://discord.com/channels/"+guild+"/"+channel;
function message(text:string) {
  return {id:post,guildId:guild,channelId:channel,channel:{isThread:()=>false},content:text,author:{id:"human",bot:false}} as unknown as Message;
}
it("uses the shared article job after WebUI registration, ignores repeated edits, and stops after removal",async()=>{
  const db=new Database(":memory:");
  try{
    const flow=discordArticleFlow(db,{} as Client,guild);
    const api=knowledgeChannelsRouter(watchedChannels(db),()=>true);
    const change=(enabled:boolean)=>api.request("/",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({target:url,enabled})});
    flow.receive(message("https://example.org/ignored"));
    expect((await change(true)).status).toBe(200);
    flow.receive(message("https://example.org/a"));
    const edited=Object.assign(message("https://example.org/a https://example.org/b"),{editedTimestamp:123});
    flow.receive(edited,message(""));
    flow.receive(edited,message(""));
    expect((await change(false)).status).toBe(200);
    flow.receive(message("https://example.org/removed"));
    seedJobs(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_flow_jobs").get()).toEqual({n:2});
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_flow_receipts").get()).toEqual({n:2});
    notifyArticle(db,1,"analysis");
    expect(db.prepare("SELECT channel,thread FROM knowledge_flow_notifications").get()).toEqual({channel:"discord:"+guild+":"+channel,thread:"post:"+channel+":"+post});
  }finally{db.close();}
});
it("accepts the management command only from a guild manager and routes results through the matching guild",async()=>{
  const db=new Database(":memory:");vi.useFakeTimers();
  const send=vi.fn(async()=>{}), other=vi.fn(async()=>{}), slack=vi.fn(async()=>{});
  const thread={send,isThread:()=>true,parentId:channel};
  const client={channels:{fetch:async()=>({guildId:guild,isTextBased:()=>true,messages:{fetch:async()=>({thread})}})}} as unknown as Client;
  const flow=discordArticleFlow(db,client,guild);
  const stopDiscord=flow.startDelivery(()=>{});
  const stopOther=startThreadDelivery(db,other,()=>{},"999999999999999999");
  const stopSlack=startThreadDelivery(db,slack,()=>{});
  try{
    const permission=vi.fn<()=>boolean>().mockReturnValue(false);
    const command=Object.assign(message("ナレッジ監視 登録"),{member:{permissions:{has:permission}},reply:vi.fn(async()=>{})});
    await flow.command(command);
    expect(watchedChannels(db).list()).toHaveLength(0);
    permission.mockReturnValue(true);
    await flow.command(command);
    flow.receive(message("https://example.org"));
    notifyArticle(db,1,"review");
    await vi.advanceTimersByTimeAsync(2500);
    expect(send).toHaveBeenCalledWith({content:"review",allowedMentions:{parse:[]}});
    expect(slack).not.toHaveBeenCalled();expect(other).not.toHaveBeenCalled();
  }finally{await Promise.all([stopDiscord(),stopOther(),stopSlack()]);vi.useRealTimers();db.close();}
});
