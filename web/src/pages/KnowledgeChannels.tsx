import { useEffect, useState } from "react";
import { api } from "../api.js";

export function KnowledgeChannels() {
  const [rows,setRows]=useState<Array<{platform:string;team:string;channel:string}>>([]);
  const [target,setTarget]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  useEffect(()=>{api.knowledgeChannels().then(r=>setRows(r.channels)).catch(e=>setError(String(e)));},[]);
  async function change(value:string,enabled:boolean){
    setBusy(true);
    try{const r=await api.knowledgeChannelSet(value,enabled);setRows(r.channels);setError("");if(enabled)setTarget("");}
    catch(e){setError(String(e));} finally{setBusy(false);}
  }
  return <section className="bg-surface border border-border rounded p-4 space-y-3">
    <h2 className="font-semibold">ナレッジフローの監視チャンネル</h2>
    <form onSubmit={e=>{e.preventDefault();void change(target,true);}} className="flex flex-wrap gap-2">
      <label>Discord チャンネルリンク、または Slack のチームID/チャンネルID
        <input className="block w-full border rounded p-1" value={target} required onChange={e=>setTarget(e.target.value)}/></label>
      <button disabled={busy} type="submit">登録</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <ul>{rows.map(r=><li key={r.platform+r.team+"/"+r.channel}>{r.platform} · {r.team}/{r.channel} <button disabled={busy} onClick={()=>void change(r.platform==="discord"?"https://discord.com/channels/"+r.team+"/"+r.channel:r.team+"/"+r.channel,false)}>解除</button></li>)}</ul>
  </section>;
}
