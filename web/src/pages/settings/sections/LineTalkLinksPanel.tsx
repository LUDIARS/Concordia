// LINE の共用チャネルのトークごとの紐付け。 どのトークにどのサービスがつながっていて、
// ふだんの相手 (言葉の無い発言の宛先) は誰か。 トーク ID は API が先頭数文字しか返さない。
// @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面

import type { LineTalkLink } from "../../../api.js";

const KIND_LABEL: Record<LineTalkLink["talk_kind"], string> = {
  group: "グループ",
  room: "トークルーム",
  user: "1 対 1",
  unknown: "不明",
};

export interface LineTalkLinksPanelProps {
  links: LineTalkLink[];
  busy: boolean;
  onSetDefault: (link: LineTalkLink) => void;
  onRemove: (link: LineTalkLink) => void;
}

/** @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面 */
export function LineTalkLinksPanel({ links, busy, onSetDefault, onRemove }: LineTalkLinksPanelProps) {
  return (
    <div className="border border-border rounded p-2 space-y-1">
      <div className="text-xs font-semibold">トークごとの紐付け</div>
      {links.length === 0
        ? <p className="text-xs text-subtle">紐付けはまだありません (トークで「つなぐ &lt;コード&gt;」と送るとつながります)</p>
        : (
          <table className="text-xs w-full">
            <thead>
              <tr className="text-subtle text-left">
                <th className="font-normal">チャネル</th>
                <th className="font-normal">トーク</th>
                <th className="font-normal">サービス</th>
                <th className="font-normal">ふだんの相手</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id}>
                  <td>{link.channel}</td>
                  <td className="font-mono">{KIND_LABEL[link.talk_kind]} {link.talk_id_prefix}…</td>
                  <td>{link.service}</td>
                  <td>
                    {link.is_default ? "○" : (
                      <button type="button" disabled={busy} onClick={() => onSetDefault(link)}
                        className="text-accent disabled:opacity-40">ふだんの相手にする</button>
                    )}
                  </td>
                  <td>
                    <button type="button" disabled={busy} onClick={() => onRemove(link)}
                      className="text-subtle hover:text-text disabled:opacity-40">解除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}
