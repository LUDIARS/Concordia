import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { parseWatchTarget, type WatchedChannels } from "../knowledge-flow/watched-channels.js";

export function localKnowledgeAdmin(c: Context): boolean {
  if (!["localhost","127.0.0.1","[::1]"].includes(new URL(c.req.url).hostname)) return false;
  if (["forwarded","x-forwarded-for","cf-connecting-ip"].some(key=>c.req.header(key))) return false;
  const origin=c.req.header("origin");
  if (origin && new URL(c.req.url).origin!==origin) return false;
  try {return ["127.0.0.1","::1","::ffff:127.0.0.1"].includes(getConnInfo(c).remote.address??"");}
  catch {return false;}
}
export function knowledgeChannelsRouter(watches: WatchedChannels, allowed=localKnowledgeAdmin) {
  const app=new Hono();
  app.use("*",async(c,next)=>{if(!allowed(c))return c.json({error:"本社PCのCcから変更してください"},403);await next();});
  app.get("/",c=>c.json({channels:watches.list()}));
  app.post("/",async c=>{
    const body=await c.req.json().catch(()=>null);
    const target=typeof body?.target==="string" ? parseWatchTarget(body.target):null;
    if(!target || typeof body?.enabled!=="boolean") return c.json({error:"有効なチャンネルを指定してください"},400);
    watches.change(target,body.enabled);
    return c.json({channels:watches.list()});
  });
  return app;
}
