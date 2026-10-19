// LINE webhook の設定面の状態と操作。 一覧 (チャネル・サービス・紐付け) を読み、
// 秘密値・push トークン・呼びかけの言葉・紐付けの変更を 1 つずつ実行して読み直す。 消去・解除・発行し直しは確認してから行う。
// @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面

import { useEffect, useState } from "react";
import type {
  api,
  LineChannelSecretField,
  LineTalkLink,
  LineWebhookChannel,
  LineWebhookService,
} from "../../../api.js";

/** 画面が使う API。 テストでは代役を渡す (root vitest は isolate:false で vi.mock が効かないことがある)。 */
export type LineWebhookSecretsClient = Pick<typeof api,
  | "lineWebhookChannels" | "lineWebhookSetChannelSecret" | "lineWebhookClearChannelSecret"
  | "lineWebhookServices" | "lineWebhookSetRelayToken" | "lineWebhookClearRelayToken" | "lineWebhookSetKeywords"
  | "lineWebhookLinks" | "lineWebhookSetDefaultLink" | "lineWebhookRemoveLink"
  | "lineWebhookIssuePushToken" | "lineWebhookClearPushToken" | "lineWebhookSetPushEnabled">;

export interface LineWebhookLoaded {
  channels: LineWebhookChannel[];
  services: LineWebhookService[];
  links: LineTalkLink[];
}

/** @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面 */
export function useLineWebhookAdmin(client: LineWebhookSecretsClient) {
  const [loaded, setLoaded] = useState<LineWebhookLoaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** 発行したての push トークン (この画面で一度だけ見せる。 読み直しでは戻らない)。 */
  const [issued, setIssued] = useState<{ service: string; token: string } | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const [channels, services, links] = await Promise.all([
        client.lineWebhookChannels(), client.lineWebhookServices(), client.lineWebhookLinks(),
      ]);
      setLoaded({ channels: channels.channels, services: services.services, links: links.links });
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  /** 1 つの変更を実行して読み直す。 成功したら true。 */
  async function perform(action: () => Promise<unknown>, message: string): Promise<boolean> {
    setBusy(true); setError(null); setNote(null);
    try {
      await action();
      await refresh();
      setNote(message);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally { setBusy(false); }
  }

  /** 空の値は送らずに知らせる。 */
  function requireValue(label: string, value: string): boolean {
    if (value !== "") return true;
    setError(`${label} を入力してください`);
    return false;
  }

  return {
    loaded, busy, error, note,
    saveChannelSecret: async (channel: string, field: LineChannelSecretField, label: string, value: string) =>
      requireValue(label, value)
      && perform(() => client.lineWebhookSetChannelSecret(channel, field, value), `${channel} の${label}を保存しました`),
    clearChannelSecret: (channel: string, field: LineChannelSecretField, label: string) => {
      if (!window.confirm(`${channel} の${label}を消去します。`)) return;
      void perform(() => client.lineWebhookClearChannelSecret(channel, field), `${channel} の${label}を消去しました`);
    },
    saveRelayToken: async (service: string, value: string) =>
      requireValue("中継トークン", value)
      && perform(() => client.lineWebhookSetRelayToken(service, value), `${service} の中継トークンを保存しました`),
    clearRelayToken: (service: string) => {
      if (!window.confirm(`${service} の中継トークンを消去します。`)) return;
      void perform(() => client.lineWebhookClearRelayToken(service), `${service} の中継トークンを消去しました`);
    },
    issued,
    dismissIssued: () => setIssued(null),
    issuePushToken: (service: string, reissue: boolean) => {
      if (reissue && !window.confirm(`${service} の push トークンを発行し直します。 今のトークンは使えなくなります。`)) return;
      setIssued(null);
      void perform(async () => {
        const res = await client.lineWebhookIssuePushToken(service);
        setIssued({ service, token: res.push_token });
      }, `${service} の push トークンを発行しました (この画面を離れると再表示できません)`);
    },
    clearPushToken: (service: string) => {
      if (!window.confirm(`${service} の push トークンを消去します。 サービスから LINE へ送れなくなります。`)) return;
      setIssued(null);
      void perform(() => client.lineWebhookClearPushToken(service), `${service} の push トークンを消去しました`);
    },
    setPushEnabled: (service: string, enabled: boolean) => {
      void perform(() => client.lineWebhookSetPushEnabled(service, enabled),
        `${service} の LINE への送信を${enabled ? "有効" : "無効"}にしました`);
    },
    saveKeywords: (service: string, keywords: string[]) =>
      perform(() => client.lineWebhookSetKeywords(service, keywords), `${service} の呼びかけの言葉を保存しました`),
    setDefaultLink: (link: LineTalkLink) => {
      void perform(() => client.lineWebhookSetDefaultLink(link.id), `${link.service} をふだんの相手にしました`);
    },
    removeLink: (link: LineTalkLink) => {
      if (!window.confirm(`${link.service} とトーク ${link.talk_id_prefix}… の紐付けを解除します。`)) return;
      void perform(() => client.lineWebhookRemoveLink(link.id), `${link.service} の紐付けを解除しました`);
    },
  };
}
