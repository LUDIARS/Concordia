# TestWorkflow の操作ボタンが表示されない

- 発生日: 2026-08-01
- 状態: fixed-in-branch
- 対象: Concordia Discord Test Forum

## 現象

Revisor の Open / Test OK PR は Test Forum に同期されるが、provider/model、effort、
「テスト開始」「マージ」の操作面が表示されない。

## 証拠と原因

稼働中 backend は `2026-08-01T03:58:10Z` 起動で、ローカル `main@ba74be7` より古い。
ただし主因は再起動漏れではない。操作面の状態遷移だけが
`feat/test-forum-controls@199e9a2` にあり、Discord 描画・interaction・session enrollment・
Revisor merge の配線は未コミット worktree に残り、`main` に一度も収録されていなかった。

## 修正要件

- 最新 local main を基点に操作面を統合する。
- session spawn と Test Forum surface を一意な ID で関連付ける。
- 起動した session を元スレッドへ束ね、同じ control message を `testing` 表示へ更新する。
- merge は社員名簿の管理職以上に限定する。
- migration 番号は既存の federation migration 46 と競合させない。

## 検証方針

ユーザの Cc 作業ポリシーにより、この branch では単体・統合・起動テストを実行しない。
Revisor TestWorkflow 登録後の審査と、許可を得た本体 build / Excubitor restart / Discord 実操作を
別途行う。
