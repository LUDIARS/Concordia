// Discord チャット中継の target ごとの中継トークンを入力・差し替え・消去する面。
// 保存済みの値は API も返さないので、 この画面は「入っているか」だけを映す。
// target そのもの (name / url / host / channelIds / enabled) は「すべて」の services.discord_chat_relay_targets で編集する。
// @implements spec/feature/discord-chat-relay.md — 中継トークン

import { useEffect, useState } from "react";
import { api, type DiscordChatRelayTargetSecrets } from "../../../api.js";

const HINT = "サービス側 (例: MemoriaForChild の親の設定) が発行した値をそのまま貼る";

/** 画面が使う API。 テストでは代役を渡す (root vitest は isolate:false で vi.mock が効かないことがある)。 */
export type DiscordChatRelaySecretsClient = Pick<
  typeof api, "discordChatRelayTargets" | "discordChatRelaySetToken" | "discordChatRelayClearToken"
>;

/** @implements spec/feature/discord-chat-relay.md — 中継トークン */
export function DiscordChatRelaySecretsSection({ client = api }: { client?: DiscordChatRelaySecretsClient } = {}) {
  const [targets, setTargets] = useState<DiscordChatRelayTargetSecrets[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // 貼り付け中の target。 開いている間だけ入力欄を出す。
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      setTargets((await client.discordChatRelayTargets()).targets);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(null); setNote(null);
    try {
      await action();
      await refresh();
      setNote(message);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  function save(target: string) {
    const value = draft.trim();
    if (value === "") { setError("中継トークンを入力してください"); return; }
    void run(async () => {
      await client.discordChatRelaySetToken(target, value);
      // 貼り付けた値は保存後に画面へ残さない。
      setDraft("");
      setEditing(null);
    }, `${target} の中継トークンを保存しました`);
  }

  function clear(target: string) {
    if (!window.confirm(`${target} の中継トークンを消去します。`)) return;
    void run(async () => {
      await client.discordChatRelayClearToken(target);
      if (editing === target) setEditing(null);
      setDraft("");
    }, `${target} の中継トークンを消去しました`);
  }

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">Discord チャット中継の中継トークン</h2>
      <p className="text-xs text-subtle">
        指定チャンネルの発言を Cc がサービスへ転送し、 返事を元の発言への返信として投稿します。
        保存した値は読み返せません (設定済みかどうかだけを表示します)。 中継トークンが未設定の target は転送しません。
      </p>
      {error && <p className="text-xs text-warn">{error}</p>}
      {targets === null ? <p className="text-xs text-subtle">読み込み中…</p>
        : targets.length === 0
          ? <p className="text-xs text-subtle">target がありません (「すべて」の Discord チャット中継 転送先に登録します)</p>
          : targets.map((target) => {
            const present = target.relay_token_set;
            return (
              <div key={target.name} className="border border-border rounded p-2 space-y-1">
                <div className="text-xs font-semibold">
                  {target.name}{!target.enabled && <span className="ml-2 text-subtle">(無効)</span>}
                </div>
                <dl className="text-xs grid grid-cols-[11rem_1fr] gap-y-1">
                  <dt className="text-subtle">チャンネル</dt>
                  <dd className="font-mono">{target.channel_ids.join(", ")}</dd>
                  <dt className="text-subtle" title={HINT}>中継トークン</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    <span className={present ? "" : "text-warn"}>{present ? "設定済み" : "未設定"}</span>
                    <button type="button" disabled={busy} onClick={() => { setEditing(target.name); setDraft(""); setNote(null); }}
                      className="text-accent disabled:opacity-40">{present ? "差し替え" : "入力"}</button>
                    {present && (
                      <button type="button" disabled={busy} onClick={() => clear(target.name)}
                        className="text-subtle hover:text-text disabled:opacity-40">消去</button>
                    )}
                    {editing === target.name && (
                      <span className="inline-flex items-center gap-1">
                        <input type="password" autoComplete="off" spellCheck={false} value={draft}
                          onChange={(e) => setDraft(e.target.value)} placeholder={HINT}
                          className="text-xs font-mono border border-border rounded px-1 py-0.5 bg-transparent w-64" />
                        <button type="button" disabled={busy} onClick={() => save(target.name)}
                          className="text-accent disabled:opacity-40">保存</button>
                        <button type="button" disabled={busy} onClick={() => { setEditing(null); setDraft(""); }}
                          className="text-subtle hover:text-text disabled:opacity-40">取消</button>
                      </span>
                    )}
                  </dd>
                </dl>
              </div>
            );
          })}
      {note && <p className="text-[11px] text-subtle">{note}</p>}
    </div>
  );
}
