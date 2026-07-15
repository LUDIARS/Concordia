# WebUI の内部 transcript JSON が作業更新を埋もれさせる

- 発生日: 2026-07-16
- 状態: fixed in working tree
- 対象: セッション詳細 / 作業内容

## 現象

セッション詳細の作業内容に、`event_msg` や `response_item` 由来の内部フレームが JSON カードとして並び、ユーザが読みたい作業更新が見つけにくい。

## 原因

Lictor はユーザ向けメッセージを `kind: text` に正規化する一方、通知対象でないプロバイダ内部イベントを `kind: raw` として保存する。WebUI は全 kind を同じ階層で展開していたため、raw/tool/thinking/system の診断情報も常時表示されていた。

## 対応方針

- text、summary、image はユーザ向けタイムラインに通常表示する。
- raw、tool、thinking、system 等は「内部イベント」トグルへ集約し、初期状態では閉じる。
- `phase: commentary` の text は「作業更新」として本文を省略せず表示する。

## 検証

- `event_msg` / `response_item` 由来の raw frame が折りたたみ対象になる単体テストを追加した。
- commentary text が「作業更新」の本文として通常表示される単体テストを追加した。
- 対象テストを含む全回帰 224 files / 1603 tests が成功した。
- WebUI の TypeScript チェックと production build が成功した。
