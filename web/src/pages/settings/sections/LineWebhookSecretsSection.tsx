// LINE webhook の target ごとの秘密値 (チャネルシークレット・チャネルアクセストークン・中継トークン) を
// 入力・差し替え・消去する面。 保存済みの値は API も返さないので、 この画面は「入っているか」だけを映す。
// target そのもの (name / url / host / enabled) は「すべて」の services.line_webhook_targets で編集する。
// @implements spec/feature/line-webhook-relay.md — チャネルの秘密値

import { useEffect, useState } from "react";
import { api, type LineChannelSecretField, type LineWebhookTargetSecrets } from "../../../api.js";

const FIELDS: ReadonlyArray<{ field: LineChannelSecretField; label: string; flag: keyof LineWebhookTargetSecrets; hint: string }> = [
  { field: "channel_secret", label: "チャネルシークレット", flag: "channel_secret_set",
    hint: "LINE Developers の「チャネル基本設定」の値。 署名の検証に使う" },
  { field: "channel_access_token", label: "チャネルアクセストークン", flag: "channel_access_token_set",
    hint: "LINE Developers の「Messaging API 設定」の長期トークン。 返信に使う" },
  { field: "relay_token", label: "中継トークン", flag: "relay_token_set",
    hint: "サービス側 (例: MemoriaForChild の親の設定) が発行した値をそのまま貼る" },
];

/** 画面が使う API。 テストでは代役を渡す (root vitest は isolate:false で vi.mock が効かないことがある)。 */
export type LineWebhookSecretsClient = Pick<typeof api, "lineWebhookTargets" | "lineWebhookSetSecret" | "lineWebhookClearSecret">;

/** @implements spec/feature/line-webhook-relay.md — チャネルの秘密値 */
export function LineWebhookSecretsSection({ client = api }: { client?: LineWebhookSecretsClient } = {}) {
  const [targets, setTargets] = useState<LineWebhookTargetSecrets[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // 貼り付け中の対象 (`<target>/<field>`)。 開いている間だけ入力欄を出す。
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      setTargets((await client.lineWebhookTargets()).targets);
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

  function save(target: string, field: LineChannelSecretField, label: string) {
    const value = draft.trim();
    if (value === "") { setError(`${label} を入力してください`); return; }
    void run(async () => {
      await client.lineWebhookSetSecret(target, field, value);
      // 貼り付けた値は保存後に画面へ残さない。
      setDraft("");
      setEditing(null);
    }, `${target} の${label}を保存しました`);
  }

  function clear(target: string, field: LineChannelSecretField, label: string) {
    if (!window.confirm(`${target} の${label}を消去します。`)) return;
    void run(async () => {
      await client.lineWebhookClearSecret(target, field);
      if (editing === `${target}/${field}`) setEditing(null);
      setDraft("");
    }, `${target} の${label}を消去しました`);
  }

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">LINE webhook の秘密値</h2>
      <p className="text-xs text-subtle">
        Cc が署名の検証と LINE への返信を行います。 保存した値は読み返せません (設定済みかどうかだけを表示します)。
        チャネルシークレットか中継トークンが未設定の target は 503 を返し、 サービスへ転送しません。
      </p>
      {error && <p className="text-xs text-warn">{error}</p>}
      {targets === null ? <p className="text-xs text-subtle">読み込み中…</p>
        : targets.length === 0
          ? <p className="text-xs text-subtle">target がありません (「すべて」の LINE webhook 転送先に登録します)</p>
          : targets.map((target) => (
            <div key={target.name} className="border border-border rounded p-2 space-y-1">
              <div className="text-xs font-semibold">
                {target.name}{!target.enabled && <span className="ml-2 text-subtle">(無効)</span>}
              </div>
              <dl className="text-xs grid grid-cols-[11rem_1fr] gap-y-1">
                {FIELDS.map(({ field, label, flag, hint }) => {
                  const key = `${target.name}/${field}`;
                  const present = target[flag] === true;
                  return (
                    <div key={field} className="contents">
                      <dt className="text-subtle" title={hint}>{label}</dt>
                      <dd className="flex flex-wrap items-center gap-2">
                        <span className={present ? "" : "text-warn"}>{present ? "設定済み" : "未設定"}</span>
                        <button type="button" disabled={busy} onClick={() => { setEditing(key); setDraft(""); setNote(null); }}
                          className="text-accent disabled:opacity-40">{present ? "差し替え" : "入力"}</button>
                        {present && (
                          <button type="button" disabled={busy} onClick={() => clear(target.name, field, label)}
                            className="text-subtle hover:text-text disabled:opacity-40">消去</button>
                        )}
                        {editing === key && (
                          <span className="inline-flex items-center gap-1">
                            <input type="password" autoComplete="off" spellCheck={false} value={draft}
                              onChange={(e) => setDraft(e.target.value)} placeholder={hint}
                              className="text-xs font-mono border border-border rounded px-1 py-0.5 bg-transparent w-64" />
                            <button type="button" disabled={busy} onClick={() => save(target.name, field, label)}
                              className="text-accent disabled:opacity-40">保存</button>
                            <button type="button" disabled={busy} onClick={() => { setEditing(null); setDraft(""); }}
                              className="text-subtle hover:text-text disabled:opacity-40">取消</button>
                          </span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          ))}
      {note && <p className="text-[11px] text-subtle">{note}</p>}
    </div>
  );
}
