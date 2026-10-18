// LINE webhook の設定面。 共用チャネルの秘密値 (チャネルシークレット・チャネルアクセストークン)、
// サービスの中継トークンと呼びかけの言葉、 トークごとの紐付けを扱う。 保存済みの秘密値は API も返さないので、
// この画面は「入っているか」 だけを映す。 サービスそのもの (name / url / host / enabled / channel) は
// 「すべて」の services.line_webhook_targets で編集する。
// @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面

import { api, type LineChannelSecretField } from "../../../api.js";
import { LineKeywordsField } from "./LineKeywordsField.js";
import { LineSecretField } from "./LineSecretField.js";
import { LineTalkLinksPanel } from "./LineTalkLinksPanel.js";
import { useLineWebhookAdmin, type LineWebhookSecretsClient } from "./useLineWebhookAdmin.js";

export type { LineWebhookSecretsClient } from "./useLineWebhookAdmin.js";
export { splitKeywords } from "./LineKeywordsField.js";

const CHANNEL_FIELDS: ReadonlyArray<{
  field: LineChannelSecretField; label: string; flag: "channel_secret_set" | "channel_access_token_set"; hint: string;
}> = [
  { field: "channel_secret", label: "チャネルシークレット", flag: "channel_secret_set",
    hint: "LINE Developers の「チャネル基本設定」の値。 署名の検証に使う" },
  { field: "channel_access_token", label: "チャネルアクセストークン", flag: "channel_access_token_set",
    hint: "LINE Developers の「Messaging API 設定」の長期トークン。 返信に使う" },
];
const RELAY_HINT = "サービス側 (例: MemoriaForChild の親の設定) が発行した値をそのまま貼る";

/** @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面 */
export function LineWebhookSecretsSection({ client = api }: { client?: LineWebhookSecretsClient } = {}) {
  const admin = useLineWebhookAdmin(client);
  const { loaded, busy } = admin;

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">LINE webhook</h2>
      <p className="text-xs text-subtle">
        1 つの LINE チャネルを複数のサービスで共用し、 Cc がグループと呼びかけの言葉で振り分けます。
        保存した秘密値は読み返せません (設定済みかどうかだけを表示します)。 チャネルシークレットが未設定のチャネルは 503 を返し、
        中継トークンが未設定のサービスへは転送しません。
      </p>
      {admin.error && <p className="text-xs text-warn">{admin.error}</p>}
      {loaded === null ? <p className="text-xs text-subtle">読み込み中…</p>
        : loaded.channels.length === 0
          ? <p className="text-xs text-subtle">サービスがありません (「すべて」の LINE webhook サービスに登録します)</p>
          : (
            <>
              {loaded.channels.map((channel) => (
                <div key={channel.name} className="border border-border rounded p-2 space-y-1">
                  <div className="text-xs font-semibold">チャネル {channel.name}</div>
                  <div className="text-xs text-subtle">
                    Webhook URL: <span className="font-mono">https://&lt;公開ホスト&gt;{channel.webhook_path}</span>
                    {" "}(サービス: {channel.services.join(", ")})
                  </div>
                  <dl className="text-xs grid grid-cols-[11rem_1fr] gap-y-1">
                    {CHANNEL_FIELDS.map(({ field, label, flag, hint }) => (
                      <LineSecretField key={field} label={label} hint={hint} present={channel[flag]} busy={busy}
                        onSave={(value) => admin.saveChannelSecret(channel.name, field, label, value)}
                        onClear={() => admin.clearChannelSecret(channel.name, field, label)} />
                    ))}
                  </dl>
                </div>
              ))}
              {loaded.services.map((service) => (
                <div key={service.name} className="border border-border rounded p-2 space-y-1">
                  <div className="text-xs font-semibold">
                    サービス {service.name}
                    <span className="ml-2 text-subtle">(チャネル {service.channel})</span>
                    {!service.enabled && <span className="ml-2 text-subtle">(無効)</span>}
                  </div>
                  <dl className="text-xs grid grid-cols-[11rem_1fr] gap-y-1">
                    <LineSecretField label="中継トークン" hint={RELAY_HINT} present={service.relay_token_set} busy={busy}
                      onSave={(value) => admin.saveRelayToken(service.name, value)}
                      onClear={() => admin.clearRelayToken(service.name)} />
                    <LineKeywordsField service={service.name} keywords={service.keywords} busy={busy}
                      onSave={(keywords) => admin.saveKeywords(service.name, keywords)} />
                  </dl>
                </div>
              ))}
              <LineTalkLinksPanel links={loaded.links} busy={busy}
                onSetDefault={admin.setDefaultLink} onRemove={admin.removeLink} />
            </>
          )}
      {admin.note && <p className="text-[11px] text-subtle">{admin.note}</p>}
    </div>
  );
}
