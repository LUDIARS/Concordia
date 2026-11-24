/**
 * 依頼窓口 (/desk、Cc v5)。軽い依頼も重い依頼もここで 1 つの窓口として受け、作業セッションを起動する (実装メモ 12)。
 * Discord の「依頼窓口」チャンネルと同じ受付 (CC-V5-INV-07)。送信ごとに受付 ID を作り、再送は同じ依頼にまとまる。
 */
import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { controlApi, type DeskRequestView } from "./control/controlApi.js";
import { usePolling } from "./control/usePolling.js";
import { DeskDetail } from "./desk/DeskDetail.js";
import { DESK_STATE_LABEL } from "./desk/deskLabels.js";
import { PastChores } from "./desk/PastChores.js";

export function Desk() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("request");
  const list = usePolling((signal) => controlApi.deskRequests(signal), 5_000);
  const [body, setBody] = useState("");
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 同じ本文の再送 (結果が分からなかった送信) は同じ受付 ID を使う。
  const pending = useRef<{ id: string; body: string; provider: string } | null>(null);
  const submit = async () => {
    if (busy || !body.trim()) return;
    setBusy(true); setError("");
    if (!pending.current || pending.current.body !== body || pending.current.provider !== provider) {
      pending.current = { id: crypto.randomUUID(), body, provider };
    }
    try {
      const { request } = await controlApi.submitDesk({ client_request_id: pending.current.id, body, provider });
      pending.current = null;
      setBody("");
      setParams({ request: request.id });
      list.reload();
    } catch (e) {
      setError(e instanceof Error && e.message === "desk_disabled" ? "依頼窓口は停止中です (設定 desk.enabled)。" : String(e));
    } finally { setBusy(false); }
  };
  const requests: DeskRequestView[] = list.data?.requests ?? [];
  return <div className="max-w-5xl mx-auto space-y-5">
    <div>
      <h1 className="text-xl font-semibold">依頼窓口</h1>
      <p className="text-sm text-subtle mt-1">依頼を書くと作業セッションを起動します。人間のアクション・判断が要るときはカードになり、<a href="/control" className="underline">管制</a>で捌けます。セッションへの細かい指示は Discord のセッションチャンネルへ。</p>
    </div>
    <form className="space-y-3 rounded border border-border p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label className="block">依頼内容<textarea required maxLength={16000} value={body} onChange={(e) => setBody(e.target.value)} rows={4} className="block w-full mt-2 rounded border border-border bg-surface p-2" /></label>
      <div className="flex gap-3 items-center">
        <label>実行CLI <select aria-label="実行CLI" value={provider} onChange={(e) => setProvider(e.target.value as "claude" | "codex")} className="bg-surface border border-border rounded p-2"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
        <button disabled={busy || !body.trim()} className="px-4 py-2 rounded bg-accent text-white disabled:opacity-50">依頼する</button>
      </div>
    </form>
    {error && <p role="alert" className="text-red-400 whitespace-pre-wrap">{error}</p>}
    {selected && <DeskDetail id={selected} />}
    <section className="space-y-2" aria-label="依頼の一覧">
      <h2 className="text-lg font-semibold">依頼</h2>
      {list.error && <p role="alert" className="text-amber-400">依頼を取得できません: {list.error}</p>}
      {list.data && requests.length === 0 && <p className="text-subtle">まだ依頼はありません。</p>}
      {requests.map((request) => <button key={request.id} type="button" onClick={() => setParams({ request: request.id })}
        className={`block w-full text-left border rounded p-3 ${selected === request.id ? "border-accent" : "border-border"}`}>
        <div className="flex flex-wrap gap-2 text-sm"><strong>{DESK_STATE_LABEL[request.state]}</strong>
          <span className="text-subtle">{request.origin} · {new Date(request.created_at).toLocaleString()}</span>
          {request.open_cards > 0 && <span className="text-amber-400">カード {request.open_cards}</span>}</div>
        <p className="break-words line-clamp-2">{request.body}</p>
      </button>)}
    </section>
    <PastChores />
  </div>;
}
