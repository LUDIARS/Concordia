// LINE webhook のサービスの push の行。 push トークンは Cc が作り、 発行した直後だけ平文を見せる
// (読み直しでは戻らない)。 発行 / 発行し直す / 消す と、 送る口を開けるかどうか (pushEnabled) を切り替える。
// @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面

export interface LinePushFieldProps {
  service: string;
  channel: string;
  tokenSet: boolean;
  enabled: boolean;
  /** 発行したての平文 (このサービスのものだけ)。 */
  issuedToken: string | null;
  busy: boolean;
  onIssue: (reissue: boolean) => void;
  onClear: () => void;
  onToggle: (enabled: boolean) => void;
  onDismissIssued: () => void;
}

/** @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面 */
export function LinePushField(props: LinePushFieldProps) {
  const { service, channel, tokenSet, enabled, issuedToken, busy } = props;
  return (
    <>
      <div className="contents">
        <dt className="text-subtle" title={`サービスが POST /hooks/line/${channel}/push/${service} に付けるトークン`}>push トークン</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span className={tokenSet ? "" : "text-warn"}>{tokenSet ? "発行済み" : "未発行"}</span>
          <button type="button" disabled={busy} onClick={() => props.onIssue(tokenSet)}
            className="text-accent disabled:opacity-40">{tokenSet ? "発行し直す" : "発行"}</button>
          {tokenSet && (
            <button type="button" disabled={busy} onClick={props.onClear}
              className="text-subtle hover:text-text disabled:opacity-40">消去</button>
          )}
        </dd>
      </div>
      {issuedToken && (
        <div className="contents">
          <dt className="text-subtle">発行したトークン</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <input readOnly aria-label={`${service} の push トークン`} value={issuedToken}
              onFocus={(e) => e.currentTarget.select()}
              className="text-xs font-mono border border-border rounded px-1 py-0.5 bg-transparent w-72" />
            <span className="text-warn">いまだけ表示します。 サービス側に貼ってから閉じてください</span>
            <button type="button" onClick={props.onDismissIssued}
              className="text-subtle hover:text-text">閉じる</button>
          </dd>
        </div>
      )}
      <div className="contents">
        <dt className="text-subtle" title="無効の間は push の口が 403 を返し、 LINE へ送らない">LINE への送信</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={enabled} disabled={busy}
              onChange={(e) => props.onToggle(e.target.checked)} aria-label={`${service} の LINE への送信`} />
            {enabled ? "有効" : "無効"}
          </label>
        </dd>
      </div>
    </>
  );
}
