# パッケージ更新のお知らせ (package-update-events)

Excubitor の ergo-watch が Ergo パッケージの更新を見つけると、1 回の実行で組み立てたお知らせ文を
`POST /v1/events/package-updates` で Concordia へ送る。Concordia は各文を本社のデプロイ通知チャンネル
(`discord.deploy_notify_channel_id`) へ Bot で順に投稿する。宛先と Bot 配送の所有者は Concordia、
文面の所有者は送り手 (Excubitor) とする。

## 受け口

- 認可は `POST /v1/events/service-deployed` と同じ `x-excubitor-token` (設定 `discord.excubitor_dispatch_token`。未設定なら loopback 待ち受けのときだけ受理)。認可なしは 401 `{"error":"unauthorized"}`。
- 本文は strict な JSON。未知のフィールドは拒否し 400 `{"error":"invalid_body"}` を返す。

```json
{"source":"ergo-watch","runId":"<1 回の実行の id、1〜128 字>","messages":[{"text":"<1〜1900 字>","private":false}]}
```

  - `source` は `ergo-watch` 固定。`messages` は 1〜20 件。
  - `private` は送り手の分類 (公開パッケージか否か) を運ぶだけで、Concordia の配送先は変えない。
- `deploy_notify_channel_id` が未設定 (または復号できない) なら台帳に触れず 503 `{"error":"not_configured"}`。
- 受理したら 202 `{"delivered":n,"failed":[{"index":i,"error":"..."}],"duplicate":bool}`。

## 重複抑止

`package_update_ledger` (migration 140) が受理済みの `(run_id, message_index)` を所有する。投稿前に claim し、
既に claim 済みの添字は投稿しない (CC-INV-03)。全添字が claim 済みなら `duplicate: true`。
投稿に失敗した添字は台帳から外し、配送済みに数えない (CC-INV-06)。同じ runId の再送で、失敗した添字だけが再投稿される。

## mention の無害化

投稿は既存のデプロイ通知の cc-channel 配送 (`allowed_mentions: { parse: [] }`) を使う。加えて本文の
`@everyone` / `@here` / `<@…>` / `<@&…>` / `<#…>` / `<!…>` / `<:name:…>` をゼロ幅空白で崩し、
表示上も mention・チャンネル参照にならないようにする。

## 実装

| ファイル | 責務 |
|---|---|
| `src/deploy/package-updates.ts` | 無害化と (runId, 添字) 単位の配送判定 (純粋) |
| `src/deploy/package-updates-runtime.ts` | SQLite 台帳 |
| `src/api/package-updates.ts` | 受け口 (認可・本文検証・未設定判定) |
| `src/bootstrap/core.ts` | デプロイ通知の Bot 配送と認可を共有して配線 |
